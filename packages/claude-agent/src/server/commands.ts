import { invalidArguments } from "@agents-in-the-cloud/core";
import type { BuiltinSlashCommand } from "@agents-in-the-cloud/agent/server/builtin-slash-commands";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionSummary } from "./rows.ts";

export const claudeAgentCommands = [
  { kind: "builtin", source: "claude", name: "resume", trigger: "/resume", description: "Choose a saved Claude Code conversation.", argumentHint: "[session-id]", preserveArguments: true },
  { kind: "builtin", source: "claude", name: "fork", trigger: "/fork", description: "Continue in a copy of this conversation." },
  { kind: "builtin", source: "claude", name: "model", trigger: "/model", description: "Switch Claude Code’s model.", argumentHint: "<model>", preserveArguments: true },
] as const satisfies readonly BuiltinSlashCommand[];
const handledElsewhere = new Set(["new", "resume", "fork", "name", "park", "model"]);

export function claudeNativeCommands(commands: readonly SlashCommand[], templateNames: ReadonlySet<string>): BuiltinSlashCommand[] {
  return commands.filter(command => !handledElsewhere.has(command.name) && !templateNames.has(command.name)).map(command => ({
    kind: "builtin", source: "claude", name: command.name, trigger: `/${command.name}`, description: command.description, argumentHint: command.argumentHint || undefined, preserveArguments: true,
  }));
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClaudeCommand = { kind: "new" | "fork" } | { kind: "resume"; sessionId?: string } | { kind: "model"; model: string };
export type ClaudeCommandResult = { kind: "done"; message: string } | { kind: "resume"; sessions: ClaudeSessionSummary[]; current: string };

export function parseClaudeCommand(text: string): ClaudeCommand | undefined {
  const match = text.trim().match(/^\/(new|fork|resume|model)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const args = match[2]?.trim() ?? "";
  if (match[1] === "model") {
    if (!/^[\w.-]+$/.test(args)) throw invalidArguments("Use /model with a model name, such as /model opus");
    return { kind: "model", model: args };
  }
  if (match[1] === "resume") {
    if (args && !uuidPattern.test(args)) throw invalidArguments("Use /resume with a session ID, or on its own to choose a conversation");
    return { kind: "resume", sessionId: args || undefined };
  }
  if (args) throw invalidArguments(`/${match[1]} doesn’t take arguments`);
  return { kind: match[1] === "new" ? "new" : "fork" };
}
