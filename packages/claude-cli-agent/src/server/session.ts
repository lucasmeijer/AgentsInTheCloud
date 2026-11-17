import { writeCliSessionFiles, type CliAgentConnection, type CliAgentSession } from "@agents-in-the-cloud/cli-agent/server";

export const claudeFileLinkInstructions = "When referring to a file you created or want the user to open, emit a Markdown link with its absolute workspace path, for example [image](/work/output.png). Use links rather than bare or code-formatted paths so the user can tap them in the AgentsInTheCloud transcript. Image links open an image viewer even though the CLI cannot display images.";

export function claudeInstructionsPath(session: CliAgentSession): string {
  return `${session.directory}/instructions.txt`;
}

export function claudeMcpConfigPath(session: CliAgentSession): string {
  return `${session.directory}/claude-mcp.json`;
}

export async function prepareClaudeSession(workspaceId: string, session: CliAgentSession, connection: CliAgentConnection): Promise<Record<string, string>> {
  const config = { mcpServers: { "agents-in-the-cloud": { type: "http", url: connection.url, headers: { Authorization: `Bearer ${connection.token}` }, alwaysLoad: true } } };
  await writeCliSessionFiles(workspaceId, session, {
    "claude-mcp.json": JSON.stringify(config),
    "instructions.txt": `${connection.instructions}\n\n${claudeFileLinkInstructions}`,
  });
  return {};
}
