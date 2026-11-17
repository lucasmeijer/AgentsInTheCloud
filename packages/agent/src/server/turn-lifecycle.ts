import type { AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { agentKey } from "./render-context.ts";
import { publishWorkspaceAgentBusy } from "./workspace-agent-busy.ts";

type AgentTurnIdentity = { workspaceId: string; agentId: string };
export type AgentTurnFinishReason = "stop" | "stopFailure";
type TurnSettler = (workspaceId: string, agentId: string, signal: AbortSignal, reason: AgentTurnFinishReason) => Promise<void>;
const turnSettlers = new Set<TurnSettler>();
const settlingTurns = new Map<string, AbortController>();

export function registerAgentTurnSettler(settler: TurnSettler): void {
  turnSettlers.add(settler);
}

export function abandonSettlingTurn(agentId: string): void {
  settlingTurns.get(agentId)?.abort();
  settlingTurns.delete(agentId);
}

export function handleAgentTurnBoundary(identity: AgentTurnIdentity, started: boolean, reason: AgentTurnFinishReason, events: AgentsInTheCloudEventBus): void {
  abandonSettlingTurn(identity.agentId);
  if (started) {
    publishWorkspaceAgentBusy({ workspaceId: identity.workspaceId, agentKey: agentKey(identity.agentId), busy: true });
  } else {
    // The finished signal can precede the CLI's last history writes, and Claude only makes
    // some of them after this request returns. Answer now; end the turn once it has settled.
    const settling = new AbortController();
    settlingTurns.set(identity.agentId, settling);
    void finishTurn(identity, settling.signal, reason, events).catch((error) => {
      console.error(`Could not finish the turn of agent ${identity.agentId}`, error);
    });
  }
}

async function finishTurn({ workspaceId, agentId }: AgentTurnIdentity, signal: AbortSignal, reason: AgentTurnFinishReason, events: AgentsInTheCloudEventBus): Promise<void> {
  await Promise.all([...turnSettlers].map((settle) => settle(workspaceId, agentId, signal, reason)));
  if (signal.aborted) return;
  settlingTurns.delete(agentId);
  publishWorkspaceAgentBusy({ workspaceId, agentKey: agentKey(agentId), busy: false });
  await events.emit("workspace_agent_turn_finished", { workspaceId, agentId });
}
