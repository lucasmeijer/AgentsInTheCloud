import type { AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { durableWorkspaceOwner } from "./runtime.ts";
import { allowWorkspaceAgentResume } from "./runtime.ts";
import { listWorkspaceAgents } from "./agent-store.ts";

export async function resumeInterruptedAgentSessions(workspaceId: string, events: AgentsInTheCloudEventBus): Promise<void> {
  try {
    allowWorkspaceAgentResume(workspaceId);
    const agents = (await listWorkspaceAgents(workspaceId)).filter(agent => !agent.readOnly);
    if (!agents.length) return;
    await (await durableWorkspaceOwner(workspaceId, { events })).resume();
  } catch (error) { console.error(`Could not resume native Agent workspace ${workspaceId}`, error); }
}
