import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, createKeyedOperationQueue, getAgentsInTheCloudRuntimeContext, readTextIfExists, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceAgentType, WorkspaceAgentTabSummary } from "@agents-in-the-cloud/shared";

const tabOrderSchema = Type.Array(Type.String());

export interface HostedAgentTab extends WorkspaceAgentTabSummary {
  agentTypeId: string;
  iconHtml: string;
}

export function createAgentPaneHost(agentTypes: readonly WorkspaceAgentType[]) {
  const byId = new Map(agentTypes.map((agentType) => [agentType.id, agentType]));
  if (byId.size !== agentTypes.length) throw new Error("Duplicate agent type identity");

  const serialize = createKeyedOperationQueue();

  async function list(context: { workspaceId: string }): Promise<HostedAgentTab[]> {
    return serialize(context.workspaceId, async () => {
      const tabs = (await Promise.all(agentTypes.map(async (agentType) =>
        (await agentType.tabs.list(context)).map((tab) => ({ ...tab, agentTypeId: agentType.id, iconHtml: agentType.iconHtml })),
      ))).flat();
      const byAgent = new Map(tabs.map(tab => [tab.id, tab]));
      if (byAgent.size !== tabs.length) throw new Error("Duplicate agent identity");
      const path = agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", context.workspaceId, "metadata", "agent-tab-order.json");
      const content = await readTextIfExists(path);
      const saved: unknown = content === undefined ? [] : JSON.parse(content);
      Value.Assert(tabOrderSchema, saved);
      const order = [
        ...saved.filter(id => byAgent.has(id)),
        ...tabs.filter(tab => !saved.includes(tab.id)).map(tab => tab.id),
      ];
      if (order.length !== saved.length || order.some((id, index) => id !== saved[index])) await writeJsonAtomic(path, order);
      return order.map(id => byAgent.get(id)!);
    });
  }

  async function owner(context: { workspaceId: string; agentId: string }) {
    const tab = (await list(context)).find((tab) => tab.id === context.agentId);
    if (!tab) throw new AgentsInTheCloudCoreError("agent_not_found", `Agent not found: ${context.agentId}`);
    return byId.get(tab.agentTypeId)!;
  }

  return {
    list,
    async render(context: { workspaceId: string; agentId: string }) {
      return (await owner(context)).tabs.render(context);
    },
    async close(context: { workspaceId: string; agentId: string }) {
      return (await owner(context)).tabs.close(context);
    },
  };
}
