import { AgentsInTheCloudCoreError, createKeyedOperationQueue } from "@agents-in-the-cloud/core";
import { buildKillSessionCommand, buildListSessionsCommand, terminalProcessSession } from "@agents-in-the-cloud/observable-terminal/server";
import { createWorkspaceMetadataState, execWorkspaceShell, workspaceRoot, workspaceTerminalProcesses } from "@agents-in-the-cloud/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const workspaceTerminalSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  tmuxSession: Type.String(),
  /**
   * A terminal process the view started and releases on close; a tmux session
   * someone else started, which the view only attaches to; or, from before
   * terminal processes, a tmux session the view started and kills on close.
   */
  sessionRelationship: Type.Union([Type.Literal("process"), Type.Literal("attached"), Type.Literal("owned")]),
});
const workspaceTerminalsSchema = Type.Array(workspaceTerminalSchema);
const mutateTerminals = createKeyedOperationQueue();

export type WorkspaceTerminal = Static<typeof workspaceTerminalSchema>;

interface TmuxSessionMetadata {
  name: string;
  createdAt: number;
  lastActivityAt: number;
  command: string;
}

interface WorkspaceTerminalCreateOptions {
  title?: string;
  command?: string;
  cwd?: string;
}

const terminalsState = createWorkspaceMetadataState("terminals.json", (value) => Value.Parse(workspaceTerminalsSchema, value), () => []);

export async function listTmuxSessions(workspaceId: string): Promise<TmuxSessionMetadata[]> {
  const separator = "\u001f";
  const format = ["#{session_name}", "#{session_created}", "#{session_activity}", "#{pane_current_command}"].join(separator);
  const result = await execWorkspaceShell(workspaceId, buildListSessionsCommand(format));
  if (result.exitCode !== 0) {
    if (/no server running|no sessions|error connecting to .*\(No such file or directory\)/.test(result.stderr)) return [];
    throw new AgentsInTheCloudCoreError("terminal_sessions_failed", result.stderr.trim() || "Could not list tmux sessions");
  }

  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, createdAt, lastActivityAt, command] = line.split(separator);
    return {
      name: name!,
      createdAt: Number(createdAt),
      lastActivityAt: Number(lastActivityAt),
      command: command!,
    };
  });
}

export async function tmuxSessionExists(workspaceId: string, name: string): Promise<boolean> {
  return (await listTmuxSessions(workspaceId)).some((session) => session.name === name);
}

export async function listWorkspaceTerminals(workspaceId: string): Promise<WorkspaceTerminal[]> {
  return terminalsState.read(workspaceId);
}

function availableTitle(existingTitles: string[], preferred?: string): string {
  const existing = new Set(existingTitles);
  const base = preferred?.trim() || "Terminal";
  if (base !== "Terminal" && !existing.has(base)) return base;
  let index = 1;
  while (existing.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function normalizeCwd(cwd?: string): string {
  const value = cwd?.trim() || workspaceRoot;
  if (value !== workspaceRoot && !value.startsWith(`${workspaceRoot}/`)) {
    throw new AgentsInTheCloudCoreError("terminal_invalid_cwd", `terminal cwd must be under ${workspaceRoot}: ${value}`);
  }
  return value;
}

function newTerminal(terminals: WorkspaceTerminal[], id: string, title: string, tmuxSession: string, sessionRelationship: WorkspaceTerminal["sessionRelationship"]): WorkspaceTerminal {
  const terminal = { id, title: availableTitle(terminals.map((item) => item.title), title), tmuxSession, sessionRelationship };
  terminals.push(terminal);
  return terminal;
}

export async function createWorkspaceTerminal(workspaceId: string, options: WorkspaceTerminalCreateOptions = {}): Promise<WorkspaceTerminal> {
  const cwd = normalizeCwd(options.cwd);
  return mutateTerminals(workspaceId, async () => {
    const terminals = [...await listWorkspaceTerminals(workspaceId)];
    const id = crypto.randomUUID();
    await workspaceTerminalProcesses(workspaceId).start({ id, command: options.command?.trim() || "exec bash", cwd, interactive: true });
    const terminal = newTerminal(terminals, id, options.title?.trim() || "Terminal", terminalProcessSession(id), "process");
    terminalsState.write(workspaceId, terminals);
    return terminal;
  });
}

export async function attachWorkspaceTerminal(workspaceId: string, tmuxSession: string): Promise<WorkspaceTerminal> {
  return mutateTerminals(workspaceId, async () => {
    if (!(await tmuxSessionExists(workspaceId, tmuxSession))) {
      throw new AgentsInTheCloudCoreError("terminal_not_found", `tmux session not found: ${tmuxSession}`);
    }
    const terminals = [...await listWorkspaceTerminals(workspaceId)];
    const terminal = newTerminal(terminals, crypto.randomUUID(), tmuxSession, tmuxSession, "attached");
    terminalsState.write(workspaceId, terminals);
    return terminal;
  });
}

export async function deleteWorkspaceTerminal(workspaceId: string, terminalId: string): Promise<void> {
  return mutateTerminals(workspaceId, async () => {
    const terminals = [...await listWorkspaceTerminals(workspaceId)];
    const index = terminals.findIndex((terminal) => terminal.id === terminalId);
    if (index < 0) throw new AgentsInTheCloudCoreError("terminal_not_found", `terminal not found: ${terminalId}`);
    const [terminal] = terminals.splice(index, 1);
    if (terminal!.sessionRelationship === "process") await workspaceTerminalProcesses(workspaceId).release(terminal!.id);
    if (terminal!.sessionRelationship === "owned") {
      const result = await execWorkspaceShell(workspaceId, buildKillSessionCommand(terminal!.tmuxSession));
      if (result.exitCode !== 0) throw new AgentsInTheCloudCoreError("terminal_close_failed", result.stderr.trim() || `could not close terminal session: ${terminal!.tmuxSession}`);
    }
    terminalsState.write(workspaceId, terminals);
  });
}
