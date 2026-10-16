import { join } from "node:path";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, commandSignal, getAgentsInTheCloudRuntimeContext, type CommandInput } from "@agents-in-the-cloud/core";
import { closeWorkspaceHelper, runWorkspaceProcess, startWorkspaceProcess, WorkspaceHelperError, WorkspaceHelperStatus, type WorkspaceExecStart, type WorkspaceExit, type WorkspaceProcess, type WorkspaceRunResult } from "@agents-in-the-cloud/workspace-helper";

/** Host side of the directory the workspace's helper listens in. */
export function workspaceHelperDirectory(id: string): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspace-helper", id);
}

export function workspaceHelperSocketPath(id: string): string {
  return join(workspaceHelperDirectory(id), "helper.sock");
}

export function closeWorkspaceHelperConnection(id: string): void {
  closeWorkspaceHelper(workspaceHelperSocketPath(id));
}

/** A signal's exit status the way shells report it, e.g. 137 for SIGKILL. */
export function workspaceExitStatus(exit: WorkspaceExit): number {
  return exit.signal === undefined ? exit.exitCode : 128 + exit.signal;
}

function describeFailure(id: string, error: Error): Error {
  if (!(error instanceof WorkspaceHelperError) || error.code !== WorkspaceHelperStatus.UNAVAILABLE) return error;
  return new AgentsInTheCloudCoreError("workspace_unavailable", `Couldn’t reach workspace ${id}. It may be stopped, or made by an older AgentsInTheCloud and need recreating.\n${error.message}`);
}

/** Runs to completion; the ambient command signal cancels it. */
export async function runInWorkspace(id: string, start: Omit<WorkspaceExecStart, "stdin" | "terminal">, options: { stdin?: CommandInput; signal?: AbortSignal; waitForReady?: boolean } = {}): Promise<WorkspaceRunResult> {
  try {
    return await runWorkspaceProcess(workspaceHelperSocketPath(id), start, { ...options, signal: options.signal ?? commandSignal() });
  } catch (error) {
    throw error instanceof Error ? describeFailure(id, error) : error;
  }
}

/** Starts a long-lived process, such as an agent or a terminal client. */
export function startInWorkspace(id: string, start: WorkspaceExecStart, options: { signal?: AbortSignal } = {}): WorkspaceProcess {
  const process = startWorkspaceProcess(workspaceHelperSocketPath(id), start, options);
  const exited = process.exited.catch((error: Error) => { throw describeFailure(id, error); });
  exited.catch(() => {});
  return { ...process, exited };
}
