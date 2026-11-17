import { WorkspaceAgents, type DurableAgentRecord } from "./durable-workspace.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineEntry, InboxDoc, LiveDoc, type ConversationId, type Cursor, type Harness, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";

export const WorkspaceAdmission = defineDoc<{
  deleted: boolean;
  closed: ConversationId[];
}>({
  kind: "agents-in-the-cloud.admission",
  version: 1,
  scope: "session",
  initial: () => ({ deleted: false, closed: [] }),
  checkpointWhen: () => false,
});

export const WorkspaceStops = defineDoc<{ tasks: Record<string, TaskId[]> }>({
  kind: "agents-in-the-cloud.stops", version: 1, scope: "session", initial: () => ({ tasks: {} }), checkpointWhen: () => false,
});

/** A background dispatcher can admit native input after its own task was captured
 * by Stop. Retain that relationship so cleanup fences the resulting run too. */
export const DurableTaskAdmissions = defineDoc<{ requests: Record<string, { conversationId: ConversationId; requestId: string }> }>({
  kind: "agents-in-the-cloud.task-admissions", version: 1, scope: "session", initial: () => ({ requests: {} }), checkpointWhen: () => false,
});

/**
 * Where Stop ended a running turn. Entries alone cannot tell a stopped turn from one a steering
 * message joins: both are a tool result followed by a user message. A bookkeeping entry without
 * model payload, like the timing entries.
 */
export const durableStopEntry = defineEntry<{ at: number }>("agents-in-the-cloud.stop");

/**
 * Resumes input a failed turn left queued: pi-durable only places queued input at a boundary, and an idle
 * conversation runs one when something is submitted. Bookkeeping with an empty model payload.
 */
export const durableQueueResumeEntry = defineEntry("agents-in-the-cloud.queue-resume");

export async function assertDurableToolAdmission(tx: Tx, api: Pick<ToolExecutionApi, "conversationId" | "taskId">) {
  const gates = await tx.doc(WorkspaceAdmission);
  if (gates.deleted || gates.closed.includes(api.conversationId)) throw new Error("Agent is closed");
  const stopped = new Set(Object.values((await tx.doc(WorkspaceStops)).tasks).flat());
  for (let id: TaskId | undefined = api.taskId; id !== undefined; id = (await tx.task(id))?.owner) if (stopped.has(id)) throw new Error("This operation was stopped");
}

export function durableStopScope(records: readonly DurableAgentRecord[], conversationId: ConversationId, tree: boolean) {
  const root = records.find(record => record.durableId === conversationId);
  return [conversationId, ...records.filter(record => tree && root && record.rootId === root.agentId).map(record => record.durableId)];
}

export async function commitDurableStop(tx: Tx, conversationId: ConversationId, tree = false) {
  const scope = durableStopScope((await tx.doc(WorkspaceAgents)).agents, conversationId, tree);
  const scopes = [];
  for (const id of scope) scopes.push({ id, tasks: await stoppedTasks(tx, id), inbox: await tx.doc(InboxDoc, id) });
  for (const { id, tasks, inbox } of scopes) {
    if ((await tx.doc(LiveDoc, id)).run) await tx.appendEntry(durableStopEntry, id, { data: { at: Date.now() } });
    for (const item of inbox.items) tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
    inbox.items = [];
    (await tx.doc(WorkspaceStops)).tasks[String(id)] = tasks;
  }
}

async function stoppedTasks(tx: Tx, conversationId: ConversationId) {
  const tasks: TaskId[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ conversationId }, 500, cursor);
    tasks.push(...page.items.filter(task => task.state.status !== "terminal" && task.kind !== "agents-in-the-cloud.delegation-anchor").map(task => task.id));
    cursor = page.next;
  } while (cursor);
  return tasks;
}

/**
 * Passive recovery barrier. Never use Conversation.abort here: that enables the
 * whole scheduler before other closed conversations have been marked. All native
 * tools (including background/receipt tasks) retain their conversation ID. Live
 * delegation is fenced by the same catalog-derived close scope.
 */
export async function markGatedDurableWork(harness: Harness) {
  const context = BACKGROUND_CONTEXT;
  const gates = await harness.snapshot(WorkspaceAdmission, context);
  const stops = await harness.snapshot(WorkspaceStops, context);
  const stopped = new Set(Object.values(stops?.tasks ?? {}).flat());
  if ((!gates || (!gates.deleted && gates.closed.length === 0)) && !stopped.size) return;
  const gated = (id: ConversationId) => gates?.deleted || gates?.closed.includes(id);
  const marked = new Set<TaskId>();
  for (;;) {
    const admissions = await harness.snapshot(DurableTaskAdmissions, context);
    // Join dispatcher cancellation before reinspection. No stopped dispatcher can
    // admit new work after this loop reaches its fixed point, including on recovery.
    for (const [owner, admission] of Object.entries(admissions?.requests ?? {})) {
      if (![...stopped].some(id => String(id) === owner)) continue;
      const submission = await harness.commit(tx => tx.submissionByRequest(admission.conversationId, admission.requestId), context);
      if (!submission || submission.status === "done" || submission.status === "unanswered") continue;
      await harness.abortSubmission(submission.id, context);
      const live = await harness.snapshot(LiveDoc, admission.conversationId, context);
      if (live?.run?.inputs.includes(submission.id) && !stopped.has(live.run.taskId)) {
        const taskId = live.run.taskId;
        await harness.commit(async tx => {
          const scope = (await tx.doc(WorkspaceStops)).tasks;
          (scope[String(admission.conversationId)] ??= []).push(taskId);
        }, context);
        stopped.add(taskId);
      }
    }
    const inspection = await harness.inspect(context);
    for (const submission of inspection.submissions) if (gated(submission.conversationId)) await harness.abortSubmission(submission.id, context);
    const tasks = inspection.tasks.filter(({ record }) => !marked.has(record.id) && (gated(record.conversationId) || stopped.has(record.id)));
    if (!tasks.length) return;
    for (const { record } of tasks) marked.add(record.id);
    // Start every mark before joining any invocation, which may itself be waiting
    // on lifecycle. Abort marks are passive and do not enable the scheduler.
    await Promise.all(tasks.map(({ record }) => harness.abortTask(record.id, context)));
  }
}

export async function settleStoppedDurableWork(harness: Harness) {
  const stopped = new Set(Object.values((await harness.snapshot(WorkspaceStops, BACKGROUND_CONTEXT))?.tasks ?? {}).flat());
  if (!stopped.size) return;
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  await Promise.all(inspection.tasks.filter(({ record }) => stopped.has(record.id))
    .map(({ record }) => harness.waitForTask(record.id, BACKGROUND_CONTEXT)));
}
