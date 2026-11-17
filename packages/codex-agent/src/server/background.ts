import { backgroundReportHtml, backgroundTranscriptHtml, backgroundTranscriptItemResponse, refreshingBackgroundDetail, type BackgroundActivity } from "@agents-in-the-cloud/agent/server/background-activity";
import type { AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import type { Turn } from "../protocol.ts";
import type { CodexRuntime } from "./runtime.ts";
import { projectCodexTurns } from "./transcript.ts";

function subagents(turns: readonly Turn[]) {
  const latest = new Map<string, { path: string; kind: string; dispatch?: string; report?: string }>();
  for (const turn of turns) for (const item of turn.items) {
    if (item.type !== "subAgentActivity") continue;
    const previous = latest.get(item.agentThreadId);
    const dispatched = item.kind === "started" || item.kind === "interacted";
    latest.set(item.agentThreadId, { path: item.agentPath, kind: item.kind, dispatch: dispatched ? item.id : previous?.dispatch, report: item.kind === "completed" ? item.id : dispatched ? undefined : previous?.report });
  }
  return latest;
}

/**
 * Codex's sub-agents: the latest activity says whether each is running. They nest by their agent path, such as
 * `/root/explorer/checker`. Codex encrypts the task it gives them, so the page says so.
 */
export function codexBackgroundActivities(runtime: { state: { turns: readonly Turn[] }; subagentThreads: CodexRuntime["subagentThreads"] }): BackgroundActivity[] {
  const latest = subagents(runtime.state.turns);
  const threads = new Map([...latest].map(([thread, { path }]) => [path, thread]));
  return [...latest].map(([thread, { path, kind, dispatch }]) => {
    const own = runtime.subagentThreads.get(thread);
    const working = kind === "started" || kind === "interacted";
    const running = working && own?.stopped !== true;
    return {
      key: thread, kind: "subagent", title: path.split("/").at(-1)!, running, startedAt: running ? own?.startedAt : undefined,
      progress: kind === "interrupted" || (working && !running) ? "Stopped" : undefined,
      details: { Task: "Unfortunately, OpenAI encrypts task descriptions, so you can't read them." }, stoppable: false, opens: "drill-in",
      startedBy: dispatch ? { itemKey: dispatch, label: "Incoming message" } : undefined, parentKey: threads.get(path.slice(0, path.lastIndexOf("/"))),
    };
  });
}

export function codexSubagentAnswer(runtime: Pick<CodexRuntime, "subagentThreads">, activity: { kind: string; id: string; agentThreadId: string }): string | undefined {
  const prefix = "subagent-completed-";
  if (activity.kind !== "completed" || !activity.id.startsWith(prefix)) return undefined;
  return runtime.subagentThreads.get(activity.agentThreadId)?.answers.get(activity.id.slice(prefix.length));
}

function subagentTranscript(turns: readonly Turn[]) {
  const finished = turns.flatMap(turn => turn.items.filter((item, index) => turn.status !== "inProgress" || ("status" in item ? item.status !== "inProgress" : index < turn.items.length - 1)).map(item => item.id));
  return projectCodexTurns(turns, new Set(finished));
}

export async function codexBackgroundDetail(runtime: CodexRuntime, activity: BackgroundActivity, ctx: AgentRenderContext): Promise<string> {
  const report = subagents(runtime.state.turns).get(activity.key)?.report;
  return refreshingBackgroundDetail(activity, backgroundTranscriptHtml(ctx, activity, subagentTranscript(await runtime.subagentTurns(activity.key))) + (report ? backgroundReportHtml(ctx, report) : ""));
}

export async function codexBackgroundRoute(runtime: CodexRuntime, activity: BackgroundActivity, path: string, url: URL, ctx: AgentRenderContext): Promise<Response | undefined> {
  return backgroundTranscriptItemResponse(ctx, activity, path, url, async () => subagentTranscript(await runtime.lastSubagentTurns(activity.key)));
}
