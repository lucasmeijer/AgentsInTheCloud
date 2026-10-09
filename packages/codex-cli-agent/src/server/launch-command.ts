import { shellQuote } from "@agents-in-the-cloud/core";
import { parseModelRef } from "@agents-in-the-cloud/llm/server";
import { managedCliLaunchScript, cliPromptText, turnSignalArgv, turnSignalShell, writeFileScript, type CliAgentSession, type CliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import { workspaceRoot } from "@agents-in-the-cloud/workspace";
import { codexAgentsInTheCloudTmTheme, codexThemeName } from "./theme.ts";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";

/** Run inside tmux so installation progress and failures stay visible in the tab. */
export function codexLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings, session: CliAgentSession, resumeId?: string): string {
  const prompt = cliPromptText(input);
  // Invocation-local overrides avoid trust prompts without changing shared config.
  // Codex splits dotted keys literally, so encode project paths in a TOML table value.
  // Keep SQLite state tab-private: simultaneous cold starts must not migrate one shared DB.
  // Config overrides also keep current Codex on its embedded server rather than a shared daemon.
  const args = [...(resumeId ? ["resume", resumeId] : []), "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--no-alt-screen", "--cd", workspaceRoot,
    "-c", `sqlite_home=${JSON.stringify(`${session.directory}/codex`)}`,
    "-c", `projects={${JSON.stringify(workspaceRoot)}={trust_level="trusted"}}`,
    // Codex reports completion through notify; its lifecycle hooks report the start of a turn.
    "-c", `notify=${JSON.stringify(turnSignalArgv(session.turnSignalCommand, "finished"))}`,
    "-c", `hooks={SessionStart=[{hooks=[{type="command",command=${JSON.stringify(`node ${shellQuote(`${session.directory}/codex/session-start.cjs`)}`)}}]}],UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(turnSignalShell(session.turnSignalCommand, "started"))}}]}]}`,
    "-c", `tui.theme=${JSON.stringify(codexThemeName)}`, "-c", "notice.hide_full_access_warning=true",
    "-c", 'cli_auth_credentials_store="file"', ...(settings.model ? ["--model", parseModelRef(settings.model)!.id] : []),
    ...(settings.thinkingLevel ? ["-c", `model_reasoning_effort=${JSON.stringify(settings.thinkingLevel)}`] : []),
    ...imagePaths.flatMap((path) => ["--image", path]), ...(prompt ? ["--", prompt] : [])];
  const setup = `# Preserve resume for older saved tabs whose rollouts lived in a private CODEX_HOME.
if [ -d ${shellQuote(`${session.directory}/codex/sessions`)} ]; then
  mkdir -p "$HOME/.codex/sessions"
  cp -a --update=none ${shellQuote(`${session.directory}/codex/sessions/.`)} "$HOME/.codex/sessions/"
fi
` + writeFileScript(`"\${CODEX_HOME:-$HOME/.codex}/themes/${codexThemeName}.tmTheme"`, codexAgentsInTheCloudTmTheme());
  return managedCliLaunchScript({ agent: "codex", args, configOverrides: [`${session.directory}/codex/instructions.override`, `${session.directory}/codex/mcp.override`], setup });
}
