import { invalidArguments } from "@agents-in-the-cloud/core";
import type { BuiltinSlashCommand } from "@agents-in-the-cloud/agent/server/builtin-slash-commands";
import type { AppsListResponse, HooksListResponse, ListMcpServerStatusResponse, PluginListResponse, ReviewTarget, SkillsListResponse, ThreadGoal, ThreadGoalStatus, ThreadListResponse } from "../protocol.ts";

export const codexSlashCommands = [
  { kind: "builtin", source: "codex", name: "new", trigger: "/new", description: "Start a fresh Codex conversation." },
  { kind: "builtin", source: "codex", name: "compact", trigger: "/compact", description: "Compact this Codex conversation." },
  { kind: "builtin", source: "codex", name: "review", trigger: "/review", description: "Review changes with Codex.", argumentHint: "[branch <name> | commit <sha> | instructions]", preserveArguments: true },
  { kind: "builtin", source: "codex", name: "fork", trigger: "/fork", description: "Continue in a copy of this conversation." },
  { kind: "builtin", source: "codex", name: "resume", trigger: "/resume", description: "Choose a saved Codex conversation.", argumentHint: "[thread-id]", preserveArguments: true },
  { kind: "builtin", source: "codex", name: "goal", trigger: "/goal", description: "View or set a goal for Codex.", argumentHint: "[objective | clear | pause | resume]", preserveArguments: true },
  { kind: "builtin", source: "codex", name: "skills", trigger: "/skills", description: "Choose or configure a native Codex skill.", argumentHint: "[name | enable <name> | disable <name>]", preserveArguments: true },
  { kind: "builtin", source: "codex", name: "mcp", trigger: "/mcp", description: "Inspect Codex’s MCP servers and tools.", argumentHint: "[verbose]", preserveArguments: true },
  { kind: "builtin", source: "codex", name: "hooks", trigger: "/hooks", description: "Inspect Codex’s lifecycle hooks." },
  { kind: "builtin", source: "codex", name: "plugins", trigger: "/plugins", description: "Browse and install Codex plugins.", argumentHint: "[install <id> | uninstall <id>]", preserveArguments: true },
  { kind: "builtin", source: "codex", name: "apps", trigger: "/apps", description: "Browse and configure Codex apps.", argumentHint: "[enable <id> | disable <id>]", preserveArguments: true },
] as const satisfies readonly BuiltinSlashCommand[];

export type CodexCommand =
  | { kind: "new" }
  | { kind: "compact" | "fork" | "hooks" }
  | { kind: "plugins"; action?: "install" | "uninstall"; id?: string }
  | { kind: "apps"; enabled?: boolean; id?: string }
  | { kind: "review"; target?: ReviewTarget }
  | { kind: "resume"; threadId?: string; cursor?: string }
  | { kind: "goal"; objective?: string; status?: ThreadGoalStatus; clear?: boolean }
  | { kind: "skills"; name?: string; path?: string; enabled?: boolean }
  | { kind: "mcp"; verbose: boolean };

export type CodexCommandResult =
  | { kind: "done"; message: string }
  | { kind: "review" }
  | { kind: "resume"; threads: ThreadListResponse }
  | { kind: "goal"; goal: ThreadGoal | null }
  | { kind: "skills"; skills: SkillsListResponse }
  | { kind: "mcp"; servers: ListMcpServerStatusResponse["data"]; verbose: boolean }
  | { kind: "hooks"; hooks: HooksListResponse }
  | { kind: "plugins"; plugins: PluginListResponse; notice?: string }
  | { kind: "apps"; apps: AppsListResponse["data"]; notice?: string };

export function parseCodexCommand(text: string): CodexCommand | undefined {
  const match = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match || !codexSlashCommands.some(command => command.name === match[1])) return;
  const name = match[1]!;
  const args = match[2]?.trim() ?? "";
  switch (name) {
    case "review": {
      if (!args) return { kind: "review" };
      if (args === "changes") return { kind: "review", target: { type: "uncommittedChanges" } };
      const target = args.match(/^(branch|commit)\s+(\S+)$/);
      if (target) return { kind: "review", target: target[1] === "branch" ? { type: "baseBranch", branch: target[2]! } : { type: "commit", sha: target[2]!, title: null } };
      if (args === "branch" || args === "commit") throw invalidArguments(`/review ${args} needs a ${args === "branch" ? "branch name" : "commit SHA"}`);
      return { kind: "review", target: { type: "custom", instructions: args } };
    }
    case "resume":
      if (args && !/^[a-zA-Z0-9_-]{1,128}$/.test(args)) throw invalidArguments("Use /resume with a thread ID, or on its own to choose a conversation");
      return { kind: "resume", threadId: args || undefined };
    case "goal":
      if (args === "clear") return { kind: "goal", clear: true };
      if (args === "pause" || args === "resume" || args === "complete") return { kind: "goal", status: args === "pause" ? "paused" : args === "resume" ? "active" : "complete" };
      return { kind: "goal", objective: args || undefined };
    case "skills": {
      const setting = args.match(/^(enable|disable)\s+(.+)$/);
      if (setting) return { kind: "skills", name: setting[2]!, enabled: setting[1] === "enable" };
      return { kind: "skills", name: args || undefined };
    }
    case "plugins": {
      if (!args) return { kind: "plugins" };
      const action = args.match(/^(install|uninstall)\s+(\S+)$/);
      if (!action) throw invalidArguments("Use /plugins, /plugins install <id>, or /plugins uninstall <id>");
      return { kind: "plugins", action: action[1] === "install" ? "install" : "uninstall", id: action[2]! };
    }
    case "apps": {
      if (!args) return { kind: "apps" };
      const action = args.match(/^(enable|disable)\s+(\S+)$/);
      if (!action) throw invalidArguments("Use /apps, /apps enable <id>, or /apps disable <id>");
      return { kind: "apps", enabled: action[1] === "enable", id: action[2]! };
    }
    case "mcp":
      if (args && args !== "verbose") throw invalidArguments("Use /mcp or /mcp verbose");
      return { kind: "mcp", verbose: args === "verbose" };
    case "new": case "compact": case "fork": case "hooks":
      if (args) throw invalidArguments(`/${name} doesn’t take arguments`);
      return { kind: name };
  }
}

export function codexCommandMutates(command: CodexCommand): boolean {
  switch (command.kind) {
    case "new": case "compact": case "fork": return true;
    case "review": return Boolean(command.target);
    case "resume": return Boolean(command.threadId);
    case "goal": return Boolean(command.clear || command.objective || command.status);
    case "skills": return command.enabled !== undefined;
    case "plugins": return Boolean(command.action);
    case "apps": return command.enabled !== undefined;
    case "hooks": case "mcp": return false;
  }
}
