import { parseModelRef } from "@agents-in-the-cloud/llm/server";
import { cliLaunchScript, cliPromptText, turnSignalShell, writeFileScript, type CliAgentSession, type CliModelSettings, type TurnBoundary } from "@agents-in-the-cloud/cli-agent/server";
import { claudeInstructionsPath, claudeMcpConfigPath } from "./session.ts";
import { shellQuote } from "@agents-in-the-cloud/core";
import { workspaceRoot } from "@agents-in-the-cloud/workspace";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { readThemeSetting } from "@agents-in-the-cloud/shared/theme";
import { claudeAgentsInTheCloudTheme, claudeThemeName } from "./theme.ts";

function turnBoundaryHooks(turnSignalCommand: string) {
  const hook = (boundary: TurnBoundary) => [{ hooks: [{ type: "command", command: turnSignalShell(turnSignalCommand, boundary) }] }];
  return { UserPromptSubmit: hook("started"), Stop: hook("finished"), StopFailure: hook("failed") };
}

export function claudeLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings, session: CliAgentSession, resume = false): string {
  const prompt = cliPromptText(input, imagePaths.map((path) => `Read the attached image at ${JSON.stringify(path)}.`));
  const cliSettings = {
    skipDangerousModePermissionPrompt: true,
    theme: `custom:${claudeThemeName}`,
    hooks: turnBoundaryHooks(session.turnSignalCommand),
  };
  const args = ["--dangerously-skip-permissions", "--settings", JSON.stringify(cliSettings), "--append-system-prompt-file", claudeInstructionsPath(session), "--mcp-config", claudeMcpConfigPath(session),
    resume ? "--resume" : "--session-id", session.id,
    ...(settings.model ? ["--model", parseModelRef(settings.model)!.id] : []),
    ...(settings.thinkingLevel ? ["--effort", settings.thinkingLevel] : []), ...(prompt ? ["--", prompt] : [])];
  const configure = `const fs = require("node:fs");
const path = require("node:path").join(require("node:os").homedir(), ".claude.json");
const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
config.installMethod = "local";
config.autoUpdates = true;
config.hasCompletedOnboarding = true;
config.projects ??= {};
config.projects[${JSON.stringify(workspaceRoot)}] = { ...config.projects[${JSON.stringify(workspaceRoot)}], hasTrustDialogAccepted: true };
const temporary = path + ".agents-in-the-cloud-" + process.pid;
fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
fs.renameSync(temporary, path);`;
  return cliLaunchScript({
    // Claude recognizes this path as npm-local and updates it in place. An arbitrary
    // npm prefix is detected as global, making updates target unwritable /usr/local.
    installDirectory: ".claude/local",
    executable: "claude", label: "Claude Code", npmPackage: "@anthropic-ai/claude-code", args,
    setup: `(
  flock 8
  node -e ${shellQuote(configure)}
) 8> "$HOME/.claude-config-setup.lock"
${writeFileScript(`"$HOME/.claude/themes/${claudeThemeName}.json"`, JSON.stringify(claudeAgentsInTheCloudTheme(readThemeSetting()), null, 2))}`,
  });
}
