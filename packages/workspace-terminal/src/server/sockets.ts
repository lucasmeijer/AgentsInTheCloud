import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { createObservableTerminalSocket, terminalSocketDimensions } from "@agents-in-the-cloud/observable-terminal/server";
import type { WorkspaceServerSocketHandler } from "@agents-in-the-cloud/shared";
import { startInWorkspace, workspaceRoot } from "@agents-in-the-cloud/workspace";
import { terminalIdFromViewKey } from "../shared.ts";
import { listWorkspaceTerminals, tmuxSessionExists } from "./workspace-terminals.ts";

export function createTerminalSocketHandler(): WorkspaceServerSocketHandler {
  return async (url) => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/views\/([^/]+)\/ws$/);
    if (!match) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const terminalId = terminalIdFromViewKey(decodeURIComponent(match[2]!));
    if (!terminalId) return undefined;
    const terminal = (await listWorkspaceTerminals(workspaceId)).find((item) => item.id === terminalId);
    if (!terminal) throw new AgentsInTheCloudCoreError("terminal_not_found", `terminal not found: ${terminalId}`);
    return createObservableTerminalSocket({
      start: (start) => startInWorkspace(workspaceId, start),
      session: terminal.tmuxSession,
      ...terminalSocketDimensions(url),
      user: "agents-in-the-cloud",
      workdir: workspaceRoot,
    }, { sessionExists: () => tmuxSessionExists(workspaceId, terminal.tmuxSession) });
  };
}
