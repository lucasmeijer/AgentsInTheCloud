import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { createObservableTerminalSocket, terminalSocketDimensions } from "@agents-in-the-cloud/observable-terminal/server";
import type { WorkspaceServerSocketHandler } from "@agents-in-the-cloud/shared";
import { startInWorkspace, workspaceRoot } from "@agents-in-the-cloud/workspace";
import type { CliAgents } from "./agents.ts";

export function cliSocketHandler(providerId: string, agents: CliAgents): WorkspaceServerSocketHandler {
  return async (url) => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)\/([^/]+)\/ws$/);
    if (!match || match[2] !== `${providerId}-agents`) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const session = await agents.ready(workspaceId, decodeURIComponent(match[3]!));
    if (session.error) throw new AgentsInTheCloudCoreError("agent_session_failed", session.error);
    return createObservableTerminalSocket({
      start: (start) => startInWorkspace(workspaceId, start), session: session.tmuxSession,
      ...terminalSocketDimensions(url),
      user: "agents-in-the-cloud", workdir: workspaceRoot, readonly: false,
    });
  };
}
