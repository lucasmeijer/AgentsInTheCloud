import { ensureSharedHome } from "../home.ts";
import { fileURLToPath } from "node:url";
import { prepareWorkspaceToolsMount } from "./workspace-tools.ts";
import { syncWorkspaceDocs } from "./workspace-docs.ts";
import {
  agentsInTheCloudDataPath,
  dockerHostAgentsInTheCloudDataPath,
  getAgentsInTheCloudRuntimeContext,
} from "@agents-in-the-cloud/core";
import type { WorkspaceModule, WorkspaceServerSocketHandler } from "@agents-in-the-cloud/shared";
import { clearAppTerminalProcesses, appTerminalProcesses, terminalSocketDimensions } from "@agents-in-the-cloud/observable-terminal/server";
import { workspaceTerminalProcesses } from "../terminal-processes.ts";

/**
 * Viewers of every terminal process connect here: those in a workspace, such as
 * Terminal views and Agents' bash calls, and those on the app's machine, such as provisioning's.
 */
const terminalProcessSocket: WorkspaceServerSocketHandler = (url) => {
  const inWorkspace = url.pathname.match(/^\/workspaces\/([^/]+)\/terminal-processes\/([^/]+)\/ws$/);
  if (inWorkspace) return workspaceTerminalProcesses(decodeURIComponent(inWorkspace[1]!)).connect(decodeURIComponent(inWorkspace[2]!), terminalSocketDimensions(url));
  const ofApp = url.pathname.match(/^\/terminal-processes\/([^/]+)\/ws$/);
  if (ofApp) return appTerminalProcesses().connect(decodeURIComponent(ofApp[1]!), terminalSocketDimensions(url));
  return undefined;
};

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const docsMountPath = "/opt/agents-in-the-cloud/docs";

export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "workspace",
  async initialize({ events, registerSocketHandler }) {
    await clearAppTerminalProcesses();
    registerSocketHandler(terminalProcessSocket);
    await ensureSharedHome();
    const runtime = getAgentsInTheCloudRuntimeContext();
    await syncWorkspaceDocs(repositoryRoot, agentsInTheCloudDataPath(runtime, "docs"));
    const toolsMount = await prepareWorkspaceToolsMount(runtime);
    events.on("workspace_plan_prepare", ({ plan }) => {
      plan.mounts.push(toolsMount);
      if (plan.mounts.some((mount) => mount.target === docsMountPath)) return;
      plan.mounts.push({
        type: "bind",
        source: dockerHostAgentsInTheCloudDataPath(runtime, "docs"),
        target: docsMountPath,
        readonly: true,
      });
    });
  },
};
