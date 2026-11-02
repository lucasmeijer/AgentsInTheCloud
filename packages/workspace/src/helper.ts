import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, commandSignal, getAgentsInTheCloudRuntimeContext, requireDocker, runCommand, type CommandInput } from "@agents-in-the-cloud/core";
import { closeWorkspaceHelper, openWorkspaceFile, readWorkspaceFile, readWorkspaceFileStream, runWorkspaceProcess, startWorkspaceProcess, statWorkspaceFiles, WorkspaceHelperError, WorkspaceHelperStatus, writeWorkspaceFile, type WorkspaceExecStart, type WorkspaceFile, type WorkspaceFileStat, type WorkspaceOpenFile, type WorkspaceProcess } from "@agents-in-the-cloud/workspace-helper";

/** Shared with the app's ingress and egress sockets; the helper listens here as well. */
export const workspaceParentSocketDirectory = "/run/agents-in-the-cloud-parent";

export function workspaceHelperSocketPath(id: string): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspace-sockets", id, "helper.sock");
}

/**
 * Restarts the helper mounted from the app so a running workspace picks up the
 * app's current binary. Workspaces created before the helper have no unit to
 * restart and mount the parent socket directory read-only; start their embedded
 * helper by hand instead.
 */
export async function refreshWorkspaceHelper(
  id: string,
  container: string,
  docker: typeof requireDocker = requireDocker,
  command: typeof runCommand = runCommand,
): Promise<void> {
  const writable = await docker(["inspect", "--format", `{{range .Mounts}}{{if eq .Destination "${workspaceParentSocketDirectory}"}}{{.RW}}{{end}}{{end}}`, container]);
  if (writable.stdout.trim() === "true") {
    // The directory bind mount updates the executable's path, but a running
    // service keeps the old inode until it is restarted. Docker reports a new
    // container running before its bootstrap process has execed systemd.
    // oxlint-disable-next-line agents-in-the-cloud/no-docker-exec
    await docker(["exec", "--user", "root", container, "sh", "-c",
      `deadline=$(( $(date +%s) + 30 )); while ! test -S /run/systemd/private; do if test "$(date +%s)" -ge "$deadline"; then echo "systemd did not start within 30 seconds" >&2; exit 1; fi; sleep 0.05; done; exec systemctl restart agents-in-the-cloud-helper.service`]);
    closeWorkspaceHelperConnection(id);
    return;
  }
  const state = ".local/state/agents-in-the-cloud-helper";
  // The helper gives its socket to this directory's owner: the app.
  const directory = agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id, "home-local", state);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rm(workspaceHelperSocketPath(id), { force: true });
  await symlink(join(directory, "helper.sock"), workspaceHelperSocketPath(id));
  // Nothing else restarts the helper in these workspaces. The executable is
  // still app-mounted, so replace any process retaining its previous inode.
  // Not runDocker: its cancellable exec wrapper would kill the detached helper.
  // oxlint-disable-next-line agents-in-the-cloud/no-docker-exec
  const started = await command(["docker", "exec", "--detach", "--user", "root", container, "sh", "-c",
    `pkill -TERM -x aitc-workspace- 2>/dev/null || true; while pgrep -x aitc-workspace- >/dev/null; do sleep 0.05; done; exec /opt/agents-in-the-cloud/bin/aitc-workspace-helper --listen /home/agents-in-the-cloud/${state}/helper.sock`]);
  if (started.exitCode !== 0) throw new AgentsInTheCloudCoreError("workspace_helper_unavailable", `Couldn’t start the helper in workspace ${id}: ${started.stderr.trim()}`);
  closeWorkspaceHelperConnection(id);
}

export function closeWorkspaceHelperConnection(id: string): void {
  closeWorkspaceHelper(workspaceHelperSocketPath(id));
}

function describeFailure(id: string, error: Error): Error {
  if (!(error instanceof WorkspaceHelperError) || error.code !== WorkspaceHelperStatus.UNAVAILABLE) return error;
  return new AgentsInTheCloudCoreError("workspace_unavailable", `Couldn’t reach workspace ${id}. It may be stopped, or made by an older AgentsInTheCloud and need recreating.\n${error.message}`);
}

/** Runs to completion; the ambient command signal cancels it. */
export async function runInWorkspace(id: string, start: Omit<WorkspaceExecStart, "stdin" | "terminal">, options: { stdin?: CommandInput; signal?: AbortSignal; waitForReady?: boolean } = {}): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  try {
    const result = await runWorkspaceProcess(workspaceHelperSocketPath(id), start, { ...options, signal: options.signal ?? commandSignal() });
    return { ...result, stderr: result.stderr.toString() };
  } catch (error) {
    throw error instanceof Error ? describeFailure(id, error) : error;
  }
}

/** Runs as root, fails unless it succeeds, and returns stdout. */
export async function requireRootInWorkspace(id: string, argv: string[], stdin?: CommandInput): Promise<string> {
  const result = await runInWorkspace(id, { argv, user: "root" }, { stdin });
  if (result.exitCode !== 0) throw new AgentsInTheCloudCoreError("workspace_command_failed", `${argv[0]} failed in workspace ${id}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  return result.stdout.toString();
}

/** Starts a long-lived process, such as an agent or a terminal client. */
export function startInWorkspace(id: string, start: WorkspaceExecStart, options: { signal?: AbortSignal } = {}): WorkspaceProcess {
  const process = startWorkspaceProcess(workspaceHelperSocketPath(id), start, options);
  const exited = process.exited.catch((error: Error) => { throw describeFailure(id, error); });
  exited.catch(() => {});
  return { ...process, exited };
}

async function describingFailure<T>(id: string, operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw error instanceof Error ? describeFailure(id, error) : error;
  }
}

/** Reads a whole regular file; the signal, or else the ambient command signal, cancels it. */
export function readFileInWorkspace(id: string, file: WorkspaceFile, options: { maxBytes: number; signal?: AbortSignal }): Promise<Buffer> {
  return describingFailure(id, readWorkspaceFile(workspaceHelperSocketPath(id), file, { maxBytes: options.maxBytes, signal: options.signal ?? commandSignal() }));
}

/** Opens a file as reading it would, and stops: fails the same way, e.g. with NOT_FOUND. */
export async function checkFileInWorkspace(id: string, file: WorkspaceFile): Promise<void> {
  const reader = readWorkspaceFileStream(workspaceHelperSocketPath(id), file, { signal: commandSignal() }).getReader();
  try {
    await describingFailure(id, reader.read());
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Describes each of these absolute paths without reading them; in request order. The signal, or else the ambient command signal, cancels it. */
export async function statFilesInWorkspace(id: string, user: WorkspaceFile["user"], paths: string[], options: { signal?: AbortSignal } = {}): Promise<WorkspaceFileStat[]> {
  if (paths.length === 0) return [];
  return await describingFailure(id, statWorkspaceFiles(workspaceHelperSocketPath(id), user, paths, { signal: options.signal ?? commandSignal() }));
}

/** Which of these absolute paths are regular files `user` can read, following symlinks; in request order. */
export async function existingFilesInWorkspace(id: string, user: WorkspaceFile["user"], paths: string[]): Promise<string[]> {
  return (await statFilesInWorkspace(id, user, paths)).filter((stat) => stat.kind === "regular" && stat.readable).map((stat) => stat.path);
}

/** Replaces or creates a file atomically, along with any missing folders. The signal, or else the ambient command signal, cancels it; one cancelled before the helper replaced the file leaves it as it was. */
export function writeFileInWorkspace(id: string, file: WorkspaceFile, content: string | Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
  return describingFailure(id, writeWorkspaceFile(workspaceHelperSocketPath(id), file, content, { signal: options.signal ?? commandSignal() }));
}

/** Opens a regular file for reads of parts of it, all from the one open file; the signal, or else the ambient command signal, closes it. */
export async function openFileInWorkspace(id: string, file: WorkspaceFile, options: { signal?: AbortSignal } = {}): Promise<WorkspaceOpenFile> {
  const opened = await describingFailure(id, openWorkspaceFile(workspaceHelperSocketPath(id), file, { signal: options.signal ?? commandSignal() }));
  // A workspace that stops while the file is open fails its reads the way it fails the open.
  return {
    stat: () => describingFailure(id, opened.stat()),
    read: (offset, length) => describingFailure(id, opened.read(offset, length)),
    close: () => opened.close(),
  };
}
