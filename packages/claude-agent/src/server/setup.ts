import { agentsInTheCloudSystemPrompt } from "@agents-in-the-cloud/agent/server/system-prompt";
import { prepareCliAgentConnection } from "@agents-in-the-cloud/agent/server";
import { checkedWorkspaceShell, cliLaunchScript, createCliModelSettings, writeCliSessionFiles } from "@agents-in-the-cloud/cli-agent/server";
import { createPiModelRuntime, installClaudeSubscriptionAuth, requireProviderSubscription } from "@agents-in-the-cloud/llm/server";

export const agentTypeId = "claude";
export const label = "Claude Code";
export const claudeCodeVersion = "2.1.296";
export const claudeExecutable = `/home/agents-in-the-cloud/.claude-cli/${claudeCodeVersion}/node_modules/.bin/claude`;
export const settings = createCliModelSettings({
  agentTypeId, provider: "anthropic", label,
  mapThinkingLevel: (level, mapped) => mapped !== null && ["low", "medium", "high", "xhigh", "max"].includes(mapped ?? level) ? mapped ?? level : undefined,
});
export async function requireSetup() {
  await requireProviderSubscription(await createPiModelRuntime(), "anthropic", "Claude");
}
function claudeAgentDirectory(agentId: string) { return `/home/agents-in-the-cloud/.local/share/agents-in-the-cloud-agents/${agentId}`; }
export function claudeConfigDirectory(agentId: string) { return `${claudeAgentDirectory(agentId)}/claude`; }
export function claudeMcpConfigPath(agentId: string) { return `${claudeAgentDirectory(agentId)}/claude-mcp.json`; }

export const renderedTranscriptInstructions = "Your replies are rendered as rich Markdown in AgentsInTheCloud's web transcript, not in a terminal. Where Claude Code's guidance about terminal output conflicts with this, follow AgentsInTheCloud's guidance.";

export async function prepareClaude(workspaceId: string, agentId: string): Promise<{ instructions: string }> {
  const [, connection] = await Promise.all([
    installClaudeSubscriptionAuth(workspaceId, claudeConfigDirectory(agentId), await createPiModelRuntime()),
    prepareCliAgentConnection(workspaceId, agentId, agentsInTheCloudSystemPrompt).then(async connection => {
      const mcp = { mcpServers: { "agents-in-the-cloud": { type: "http", url: connection.url, headers: { Authorization: `Bearer ${connection.token}` }, alwaysLoad: true } } };
      await writeCliSessionFiles(workspaceId, { directory: claudeAgentDirectory(agentId) }, { "claude-mcp.json": JSON.stringify(mcp) });
      return connection;
    }),
    checkedWorkspaceShell(workspaceId, cliLaunchScript({ executable: "claude", label, npmPackage: "@anthropic-ai/claude-code", version: claudeCodeVersion, args: ["--version"] })),
  ]);
  return { instructions: [connection.instructions, renderedTranscriptInstructions].join("\n\n") };
}
