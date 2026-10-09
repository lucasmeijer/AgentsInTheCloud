import { parseModelRef } from "@agents-in-the-cloud/llm/server";
import { managedCliLaunchScript, cliPromptText, type CliAgentSession, type CliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { piAgentsInTheCloudExtensionPath } from "./session.ts";

/** Install and update Pi, independent of the Pi libraries AgentsInTheCloud embeds. */
export function piLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings, session: CliAgentSession, resumePath?: string): string {
  const prompt = cliPromptText(input);
  const model = settings.model ? parseModelRef(settings.model)! : undefined;
  // Pi treats @-prefixed positionals as file attachments even after --.
  const message = prompt.startsWith("@") ? `\n${prompt}` : prompt;
  const args = ["--approve", "--offline", "--tui-mode", "regular", "--session-dir", `/home/agents-in-the-cloud/.local/share/pi/sessions/${session.id}`,
    ...(resumePath ? ["--session", resumePath] : []),
    "--extension", piAgentsInTheCloudExtensionPath(session),
    ...(model ? ["--provider", model.provider, "--model", model.id] : []),
    ...(settings.thinkingLevel ? ["--thinking", settings.thinkingLevel] : []),
    "--", ...imagePaths.map((path) => `@${path}`), ...(message ? [message] : [])];
  // Pi's default system theme derives its colors from the terminal, which follows the viewer's theme.
  return managedCliLaunchScript({ agent: "pi", args });
}
