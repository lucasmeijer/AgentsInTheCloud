import { createHash } from "node:crypto";
import { posix } from "node:path";
import { execWorkspaceCommandBuffer, readFileInWorkspace, workspaceRoot, WorkspaceHelperError, WorkspaceHelperStatus, writeFileInWorkspace } from "@agents-in-the-cloud/workspace";
import type { EditableFileResponse } from "../protocol.ts";

export const maxEditableFileBytes = 2_000_000;

export class EditableFileError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function requestedEditableFilePath(input: string | null): string {
  const path = posix.resolve(workspaceRoot, input || workspaceRoot);
  if (path === workspaceRoot) throw new EditableFileError("Choose a text file to edit", 422);
  return path;
}

function revision(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function editableTarget(workspaceId: string, inputPath: string | null): Promise<string> {
  const requested = requestedEditableFilePath(inputPath);
  const parent = posix.dirname(requested);
  const result = await execWorkspaceCommandBuffer(workspaceId, ["sh", "-c", "test -d \"$1\" && realpath -ez -- \"$1\"", "sh", parent]);
  if (result.exitCode !== 0) throw new EditableFileError("Folder not found", 404);
  const directory = result.stdout.subarray(0, -1).toString("utf8");
  return posix.join(directory, posix.basename(requested));
}

export async function readEditableFile(workspaceId: string, inputPath: string | null): Promise<EditableFileResponse> {
  const path = await editableTarget(workspaceId, inputPath);
  const script = `if ! test -e "$1"; then exit 44; fi
if test -L "$1" || ! test -f "$1"; then exit 45; fi
size=$(stat -c %s -- "$1")
if test "$size" -gt "$2"; then exit 46; fi
if test -w "$1"; then printf '1\\0'; else printf '0\\0'; fi
cat -- "$1"`;
  const result = await execWorkspaceCommandBuffer(workspaceId, ["sh", "-c", script, "sh", path, String(maxEditableFileBytes)]);
  if (result.exitCode === 44) throw new EditableFileError("File not found", 404);
  if (result.exitCode === 45) throw new EditableFileError("Only regular files can be edited", 422);
  if (result.exitCode === 46) throw new EditableFileError("Files larger than 2 MB cannot be edited", 413);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to read file");
  const separator = result.stdout.indexOf(0);
  const writable = result.stdout.subarray(0, separator).toString("utf8") === "1";
  const bytes = result.stdout.subarray(separator + 1);
  if (bytes.includes(0)) throw new EditableFileError("Only text files can be edited", 415);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EditableFileError("Only UTF-8 text files can be edited", 415);
  }
  return { content, revision: revision(bytes), writable };
}

function savingError(error: WorkspaceHelperError): Error {
  if (error.code === WorkspaceHelperStatus.NOT_FOUND) return new EditableFileError("File not found", 404);
  if (error.code === WorkspaceHelperStatus.FAILED_PRECONDITION) return new EditableFileError("Only regular files can be edited", 422);
  if (error.code === WorkspaceHelperStatus.PERMISSION_DENIED) return new EditableFileError("File is read-only", 403);
  if (error.code === WorkspaceHelperStatus.RESOURCE_EXHAUSTED) return new EditableFileError("File changed on disk", 409);
  return error;
}

export async function writeEditableFile(workspaceId: string, inputPath: string | null, content: string, expectedRevision: string, force: boolean): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > maxEditableFileBytes) throw new EditableFileError("Files larger than 2 MB cannot be edited", 413);
  if (content.includes("\0")) throw new EditableFileError("Only text files can be edited", 415);
  const file = { user: "agents-in-the-cloud", path: await editableTarget(workspaceId, inputPath) } as const;
  try {
    if (!force && revision(await readFileInWorkspace(workspaceId, file, { maxBytes: maxEditableFileBytes })) !== expectedRevision) throw new EditableFileError("File changed on disk", 409);
    await writeFileInWorkspace(workspaceId, file, bytes);
  } catch (error) {
    throw error instanceof WorkspaceHelperError ? savingError(error) : error;
  }
  return revision(bytes);
}
