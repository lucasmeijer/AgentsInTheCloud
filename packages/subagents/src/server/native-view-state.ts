import { durableWorkspaceOwner, isOneShotAgent } from "@agents-in-the-cloud/builtin-agent/server";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { nativeStatus } from "./native-runtime.ts";
import { Delegation } from "./native-state.ts";

export async function nativeSnapshot(workspaceId: string) {
  const owner = await durableWorkspaceOwner(workspaceId);
  const records = await owner.catalog();
  const agents = await owner.harness.commit(async tx => {
    const agents = [];
    for (const record of records.filter(item => item.parentId && !isOneShotAgent(item))) agents.push({
      id: record.agentId, parentId: record.parentId!, rootId: record.rootId!, taskName: record.taskName!,
      status: await nativeStatus(tx, record), task: record.title,
    });
    return agents;
  }, context);
  return { agents, messages: Object.values((await owner.harness.snapshot(Delegation, context))?.receipts ?? {}) };
}
export type NativeSubagentView = Awaited<ReturnType<typeof nativeSnapshot>>["agents"][number];
export function viewPath(agents: readonly NativeSubagentView[], id: string): string {
  const agent = agents.find(item => item.id === id);
  return agent ? `${viewPath(agents, agent.parentId)}/${agent.taskName}` : "/root";
}
