import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError, LineScanner, ok, type BinaryReader, type ExecutionEnv, type FileErrorCode, type FileInfo, type Result } from "@earendil-works/pi-durable/env";
import { openFileInWorkspace, readFileInWorkspace, runInWorkspace, statFilesInWorkspace, workspaceRoot, WorkspaceHelperError, WorkspaceHelperStatus, writeFileInWorkspace } from "@agents-in-the-cloud/workspace";

const user = "agents-in-the-cloud";
const home = "/home/agents-in-the-cloud";
/** Larger files fail to read whole; `read` pages through any size, and the agent can use bash. */
const maxWholeFileBytes = 64 * 1024 * 1024;
const scanChunkBytes = 1024 * 1024;

/** Where `path` is in the workspace: relative to /work, with `~` its user's home, as the Node environment resolves locally. */
export function workspaceAbsolutePath(path: string): string {
  let normalized = path;
  if (normalized === "~") normalized = home;
  else if (normalized.startsWith("~/")) normalized = posix.join(home, normalized.slice(2));
  else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return posix.resolve(workspaceRoot, normalized);
}

/** The helper's failures that are expected of a file, by its status. */
function helperFileErrorCode(code: number): FileErrorCode {
  switch (code) {
    case WorkspaceHelperStatus.NOT_FOUND: return "not_found";
    case WorkspaceHelperStatus.PERMISSION_DENIED: return "permission_denied";
    case WorkspaceHelperStatus.INVALID_ARGUMENT:
    case WorkspaceHelperStatus.FAILED_PRECONDITION: return "invalid";
    default: return "unknown";
  }
}

/** Expected failures, such as a missing file, become results; a workspace that can't be reached stays an `unknown` failure with its message. */
async function attempt<T>(path: string, context: Context, operation: () => Promise<T>): Promise<Result<T, FileError>> {
  if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
  try {
    return ok(await operation());
  } catch (error) {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    const cause = error instanceof Error ? error : new Error(String(error));
    const code = error instanceof WorkspaceHelperError ? helperFileErrorCode(error.code) : "unknown";
    return err(new FileError(code, cause.message, path, cause));
  }
}

async function stat(workspaceId: string, path: string) {
  const [described] = await statFilesInWorkspace(workspaceId, user, [path]);
  return described!;
}

/** `fileInfo` as the Node environment's `lstat` gives it, from what the helper reports. */
async function fileInfo(workspaceId: string, path: string): Promise<Result<FileInfo, FileError>> {
  const described = await stat(workspaceId, path);
  if (described.kind === "regular" || described.kind === "directory") {
    const kind = described.symlink ? "symlink" : described.kind === "regular" ? "file" : "directory";
    return ok({ name: posix.basename(path), path, kind, size: described.size, mtimeMs: described.modified.getTime() });
  }
  if (described.kind === "other") return err(new FileError("invalid", "Unsupported file type", path));
  if (described.kind === "inaccessible") return err(new FileError("permission_denied", `EACCES: permission denied, lstat '${path}'`, path));
  return err(new FileError("not_found", `ENOENT: no such file or directory, lstat '${path}'`, path));
}

function unsupported(path: string): Result<never, FileError> {
  return err(new FileError("not_supported", "Workspace files support only what read, write, edit and code mode need", path));
}

/**
 * The files of one workspace, as its agent user reaches them through the workspace helper: what pi-durable's read,
 * write and edit tools, and code mode's output files, need of an execution environment. The rest fails with
 * `not_supported`; commands run through the bash tool instead.
 */
export class WorkspaceFileSystem implements ExecutionEnv {
  readonly id: string;
  cwd = workspaceRoot;

  constructor(private readonly workspaceId: string) {
    this.id = `workspace:${workspaceId}`;
  }

  async absolutePath(path: string) { return ok<string, FileError>(workspaceAbsolutePath(path)); }
  async joinPath(parts: string[]) { return ok<string, FileError>(posix.join(...parts)); }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const absolute = workspaceAbsolutePath(path);
    const result = await attempt(absolute, context, () => fileInfo(this.workspaceId, absolute));
    return result.ok ? result.value : result;
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : info;
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const absolute = workspaceAbsolutePath(path);
    const described = await attempt(absolute, context, () => stat(this.workspaceId, absolute));
    if (!described.ok) return described;
    const { value } = described;
    if (value.kind === "regular" || value.kind === "directory" || value.kind === "other") {
      if (value.canonicalPath !== undefined) return ok(value.canonicalPath);
    } else if (value.kind === "inaccessible") return err(new FileError("permission_denied", `EACCES: permission denied, realpath '${absolute}'`, absolute));
    return err(new FileError("not_found", `ENOENT: no such file or directory, realpath '${absolute}'`, absolute));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const absolute = workspaceAbsolutePath(path);
    // Buffer keeps a byte-order mark, as Node's readFile does; edit puts it back after matching.
    return attempt(absolute, context, async () => (await readFileInWorkspace(this.workspaceId, { user, path: absolute }, { maxBytes: maxWholeFileBytes })).toString("utf8"));
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const absolute = workspaceAbsolutePath(path);
    return attempt(absolute, context, () => writeFileInWorkspace(this.workspaceId, { user, path: absolute }, content));
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const absolute = workspaceAbsolutePath(path);
    if (options?.noFollow) return err(new FileError("not_supported", "Workspace files always follow symlinks", absolute));
    const opened = await attempt(absolute, context, () => openFileInWorkspace(this.workspaceId, { user, path: absolute }, { signal: context.abortSignal }));
    if (!opened.ok) {
      // The helper refuses anything but a regular file alike; tell a folder apart, as the Node environment does.
      const info = opened.error.code === "invalid" ? await this.fileInfo(absolute, context) : undefined;
      if (info?.ok && info.value.kind === "directory") return err(new FileError("is_directory", "EISDIR: illegal operation on a directory, read", absolute));
      return opened;
    }
    const file = opened.value;
    return ok({
      info: (readContext) => attempt(absolute, readContext, async () => {
        const { size, modified } = await file.stat();
        return { name: posix.basename(absolute), path: absolute, kind: "file", size, mtimeMs: modified.getTime() };
      }),
      read: (offset, length, readContext) => attempt(absolute, readContext, () => file.read(offset, length)),
      async scanLines(range, scanContext) {
        let scanner: LineScanner;
        try {
          scanner = new LineScanner(range.startLine, range.endLine);
        } catch {
          return err(new FileError("invalid", "Invalid line range", absolute));
        }
        return attempt(absolute, scanContext, async () => {
          for (let position = 0; ; position += scanChunkBytes) {
            const chunk = await file.read(position, scanChunkBytes);
            if (chunk.byteLength > 0) scanner.push(chunk);
            if (chunk.byteLength < scanChunkBytes) return scanner.finish();
          }
        });
      },
      async close() { file.close(); },
    });
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return attempt("/tmp", context, async () => {
      const result = await runInWorkspace(this.workspaceId, { argv: ["mktemp", "-d", `/tmp/${prefix ?? ""}XXXXXX`], user });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `mktemp exited with ${result.exitCode}`);
      return result.stdout.toString().trim();
    });
  }

  async openTextLineReader(path: string) { return unsupported(path); }
  async readTextLines(path: string) { return unsupported(path); }
  async readBinaryFile(path: string) { return unsupported(path); }
  async appendFile(path: string) { return unsupported(path); }
  async truncateFile(path: string) { return unsupported(path); }
  async flushFile(path: string) { return unsupported(path); }
  async renameFile(path: string) { return unsupported(path); }
  async listDir(path: string) { return unsupported(path); }
  async openDirReader(path: string) { return unsupported(path); }
  async watch() { return unsupported(this.cwd); }
  async createDir(path: string) { return unsupported(path); }
  async remove(path: string) { return unsupported(path); }
  async createTempFile() { return unsupported("/tmp"); }
  async exec(): Promise<Result<never, ExecutionError>> { return err(new ExecutionError("shell_unavailable", "Workspace commands run through the bash tool")); }
  async cleanup() {}
}
