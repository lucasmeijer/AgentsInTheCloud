import { parseModelRef } from "@agents-in-the-cloud/llm/server";
import { managedCliLaunchScript, cliPromptText, type CliAgentSession, type CliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { piAgentsInTheCloudExtensionPath } from "./session.ts";

export function piLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings, session: CliAgentSession, resumePath?: string): string {
  const prompt = cliPromptText(input);
  const model = settings.model ? parseModelRef(settings.model)! : undefined;
  const message = prompt.startsWith("@") ? `\n${prompt}` : prompt;
  const args = ["--approve", "--offline", "--tui-mode", "regular", "--session-dir", `/home/agents-in-the-cloud/.local/share/pi/sessions/${session.id}`,
    ...(resumePath ? ["--session", resumePath] : []),
    "--extension", piAgentsInTheCloudExtensionPath(session),
    ...(model ? ["--provider", model.provider, "--model", model.id] : []),
    ...(settings.thinkingLevel ? ["--thinking", settings.thinkingLevel] : []),
    "--", ...imagePaths.map((path) => `@${path}`), ...(message ? [message] : [])];
  return managedCliLaunchScript({ agent: "pi", args });
}
