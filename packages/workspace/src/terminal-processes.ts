import { createTerminalProcesses, type TerminalProcesses } from "@agents-in-the-cloud/observable-terminal/server";
import { runInWorkspace, startInWorkspace } from "./helper.ts";

const terminalProcessesRoot = "/home/agents-in-the-cloud/.local/state/agents-in-the-cloud/terminal-processes";

export function workspaceTerminalProcesses(workspaceId: string): TerminalProcesses {
  return createTerminalProcesses({
    root: terminalProcessesRoot,
    run: (start, options) => runInWorkspace(workspaceId, start, options),
    start: (start) => startInWorkspace(workspaceId, start),
  });
}
