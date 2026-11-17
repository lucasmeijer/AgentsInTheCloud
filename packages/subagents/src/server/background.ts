import { backgroundReportHtml, type BackgroundActivity } from "@agents-in-the-cloud/agent/server/background-activity";
import { childAgentTranscriptHtml, stopChildAgent, type BackgroundActivitySource } from "@agents-in-the-cloud/builtin-agent/server";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { nativeSnapshot, type NativeSubagentView } from "./native-view-state.ts";
import { Delegation, type Receipt } from "./native-state.ts";

type SubagentState = { agents: ReadonlyArray<Pick<NativeSubagentView, "id" | "parentId" | "rootId" | "taskName" | "status" | "task">>; messages: ReadonlyArray<Pick<Receipt, "id" | "from" | "to" | "kind" | "callId">> };

function latestExchange(snapshot: SubagentState, rootId: string, agentId: string) {
  const exchange = snapshot.messages.filter(message => (message.kind === "task" && message.from === rootId && message.to === agentId) || (message.kind === "completion" && message.from === agentId && message.to === rootId));
  const task = exchange.findLastIndex(message => message.kind === "task");
  return { task: exchange[task], answer: exchange.findLast((message, index) => message.kind === "completion" && index > task) };
}

export function subagentActivities(snapshot: SubagentState, rootId: string): BackgroundActivity[] {
  return snapshot.agents.filter(agent => agent.rootId === rootId && agent.status !== "closed").map(agent => {
    const running = agent.status === "running" || agent.status === "pending";
    const exchange = agent.parentId === rootId ? latestExchange(snapshot, rootId, agent.id) : undefined;
    return {
      key: agent.id, kind: "subagent", title: agent.taskName, running, details: { Task: agent.task }, stoppable: true, opens: "drill-in",
      progress: agent.status === "pending" ? "Waiting to start" : agent.status === "failed" ? "Failed" : agent.status === "interrupted" ? "Stopped" : undefined,
      startedBy: exchange?.task?.callId ? { itemKey: exchange.task.callId, label: "Tool call" } : undefined, parentKey: agent.parentId === rootId ? undefined : agent.parentId,
    };
  });
}

export const subagentBackground: BackgroundActivitySource = {
  async activities(workspaceId, rootId) {
    return subagentActivities(await nativeSnapshot(workspaceId), rootId);
  },
  async watch(harness, changed) {
    const watch = await harness.watchDoc(Delegation, BACKGROUND_CONTEXT);
    watch?.start(async () => { changed(); });
    return async () => { await watch?.stop(); };
  },
  async detail(workspaceId, rootId, activity) {
    const answer = activity.parentKey ? undefined : latestExchange(await nativeSnapshot(workspaceId), rootId, activity.key).answer;
    return childAgentTranscriptHtml(workspaceId, activity.key) + (answer ? backgroundReportHtml({ workspaceId, agentId: rootId }, answer.id) : "");
  },
  stop: (workspaceId, activity) => stopChildAgent(workspaceId, activity.key),
};
