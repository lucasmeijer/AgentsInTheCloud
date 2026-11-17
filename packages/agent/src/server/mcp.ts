import type { AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { execWorkspaceShell } from "@agents-in-the-cloud/workspace";
import { authenticateAgentRequest, createAgentMcpCredentials } from "./mcp-credentials.ts";
import { createAgentMcpServer } from "./mcp-server.ts";
import { createAgentsInTheCloudControlTools } from "./tools.ts";
import { abandonSettlingTurn, handleAgentTurnBoundary, type AgentTurnFinishReason } from "./turn-lifecycle.ts";
import { prepareAppendedAgentsInTheCloudInstructions, sharedAgentsInTheCloudInstructions } from "./system-prompt.ts";
import { formatProjectInstructions, loadWorkspaceAgentsFiles } from "./workspace-agents-files.ts";

async function agentInstructions(workspaceId: string, agentId: string, applicationInstructions = sharedAgentsInTheCloudInstructions): Promise<string> {
  return [applicationInstructions, ...await prepareAppendedAgentsInTheCloudInstructions(events, workspaceId, agentId)].join("\n\n");
}

let credentials: ReturnType<typeof createAgentMcpCredentials> | undefined;
function credentialStore() { return credentials ??= createAgentMcpCredentials(); }
let events: AgentsInTheCloudEventBus | undefined;
const mcp = createAgentMcpServer({
  authenticate: (token) => credentialStore().authenticate(token),
  tools: ({ workspaceId }) => createAgentsInTheCloudControlTools(workspaceId, { events }),
  instructions: ({ workspaceId, agentId }) => agentInstructions(workspaceId, agentId),
});
export function configureAgentMcp(eventBus: AgentsInTheCloudEventBus): void {
  events = eventBus;
  eventBus.on("workspace_deleting", async ({ workspaceId }) => {
    credentialStore().revokeWorkspace(workspaceId);
    await mcp.revoke({ workspaceId });
  });
}
export function handleAgentMcpRequest(request: Request, workspaceId?: string): Promise<Response> | undefined {
  const path = new URL(request.url).pathname;
  if (path === "/mcp") return mcp.fetch(request, workspaceId);
  if (path === "/agent-turn-started") return handleTurnBoundary(request, workspaceId, true);
  if (path === "/agent-turn-finished") return handleTurnBoundary(request, workspaceId, false, "stop");
  if (path === "/agent-turn-failed") return handleTurnBoundary(request, workspaceId, false, "stopFailure");
}

export async function revokeAgentMcp(workspaceId: string, agentId: string): Promise<void> {
  abandonSettlingTurn(agentId);
  credentialStore().revoke({ workspaceId, agentId });
  await mcp.revoke({ workspaceId, agentId });
}

export interface CliAgentConnection {
  url: string;
  token: string;
  instructions: string;
}

export async function prepareCliAgentConnection(workspaceId: string, agentId: string, applicationInstructions?: string): Promise<CliAgentConnection> {
  const [, appended, agentsFiles] = await Promise.all([startMcpRelay(workspaceId), agentInstructions(workspaceId, agentId, applicationInstructions), loadWorkspaceAgentsFiles(workspaceId, { includeRoot: false })]);
  const instructions = [appended, ...agentsFiles.map(formatProjectInstructions)].join("\n\n");
  return { url: "http://127.0.0.1:2988/mcp", token: credentialStore().issue({ workspaceId, agentId, instructionDelivery: "system-prompt" }), instructions };
}

async function startMcpRelay(workspaceId: string): Promise<void> {
  const result = await execWorkspaceShell(workspaceId, `set -eu
# One loopback HTTP listener per workspace; parent Unix sockets survive host restarts.
(
  flock 9
  if ! curl --noproxy '*' --max-time 2 --silent http://127.0.0.1:2988/health | grep -qx ok; then
    nohup socat TCP4-LISTEN:2988,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/agents-in-the-cloud-parent/ingress.sock > /tmp/agents-in-the-cloud-mcp.log 2>&1 < /dev/null 9>&- &
  fi
) 9>/tmp/agents-in-the-cloud-mcp.lock
for attempt in $(seq 1 50); do
  if curl --noproxy '*' --max-time 2 --silent http://127.0.0.1:2988/health | grep -qx ok; then exit 0; fi
  sleep .1
done
cat /tmp/agents-in-the-cloud-mcp.log >&2
exit 1`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not start workspace MCP relay");
}

async function handleTurnBoundary(request: Request, workspaceId: string | undefined, started: boolean, reason: AgentTurnFinishReason = "stop"): Promise<Response> {
  const identity = authenticateAgentRequest(request, credentialStore().authenticate, workspaceId);
  if (identity instanceof Response) return identity;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  handleAgentTurnBoundary(identity, started, reason, events!);
  return new Response(null, { status: 204 });
}
