import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, commandSignal, getAgentsInTheCloudRuntimeContext, requireDocker, runCommand, type CommandInput } from "@agents-in-the-cloud/core";
import { closeWorkspaceHelper, runWorkspaceProcess, startWorkspaceProcess, WorkspaceHelperError, WorkspaceHelperStatus, type WorkspaceExecStart, type WorkspaceExit, type WorkspaceProcess, type WorkspaceRunResult } from "@agents-in-the-cloud/workspace-helper";

/** Shared with the app's ingress and egress sockets; the helper listens here as well. */
export const workspaceParentSocketDirectory = "/run/agents-in-the-cloud-parent";

export function workspaceHelperSocketPath(id: string): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspace-sockets", id, "helper.sock");
}

/**
 * Migration: workspaces created before the helper have no unit to start it and
 * mount the parent socket directory read-only. Start it by hand, listening in
 * their per-workspace state directory, and link its socket where the app looks.
 */
export async function startLegacyWorkspaceHelper(id: string, container: string): Promise<void> {
  const writable = await requireDocker(["inspect", "--format", `{{range .Mounts}}{{if eq .Destination "${workspaceParentSocketDirectory}"}}{{.RW}}{{end}}{{end}}`, container]);
  if (writable.stdout.trim() === "true") return;
  const state = ".local/state/agents-in-the-cloud-helper";
  // The helper gives its socket to this directory's owner: the app.
  const directory = agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id, "home-local", state);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rm(workspaceHelperSocketPath(id), { force: true });
  await symlink(join(directory, "helper.sock"), workspaceHelperSocketPath(id));
  // Not runDocker: its cancellable exec wrapper would kill the detached helper.
  const started = await runCommand(["docker", "exec", "--detach", "--user", "root", container, "sh", "-c",
    `pgrep -x aitc-workspace- >/dev/null || exec /opt/agents-in-the-cloud/bin/aitc-workspace-helper --listen /home/agents-in-the-cloud/${state}/helper.sock`]);
  if (started.exitCode !== 0) throw new AgentsInTheCloudCoreError("workspace_helper_unavailable", `Couldn’t start the helper in workspace ${id}: ${started.stderr.trim()}`);
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
