import { execWorkspaceCommandBuffer } from "@agents-in-the-cloud/workspace";
import { isImageFile } from "../image-file.ts";
import { EditableFileError, maxEditableFileBytes, requestedEditableFilePath } from "./editable-file.ts";

export type FilePreviewKind = "text" | "image" | "video" | "audio" | "binary" | "large-text";

export async function filePreviewKind(workspaceId: string, inputPath: string): Promise<FilePreviewKind> {
  const path = requestedEditableFilePath(inputPath);
  const script = `if ! test -e "$1"; then exit 44; fi
if test -L "$1" || ! test -f "$1"; then exit 45; fi
stat -c %s -- "$1"
file -b --mime-type -- "$1"
file -b --mime-encoding -- "$1"`;
  const result = await execWorkspaceCommandBuffer(workspaceId, ["sh", "-c", script, "sh", path]);
  if (result.exitCode === 44) throw new EditableFileError("File not found", 404);
  if (result.exitCode === 45) throw new EditableFileError("Only regular files can be opened", 422);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to inspect file");
  const [size, mime, encoding] = result.stdout.toString("utf8").trim().split("\n");
  const mediaMime = Bun.file(path).type.split(";")[0]!;
  if (isImageFile(path) || mime!.startsWith("image/") || mediaMime.startsWith("image/")) return "image";
  if (mime!.startsWith("video/") || mediaMime.startsWith("video/")) return "video";
  if (mime!.startsWith("audio/") || mediaMime.startsWith("audio/")) return "audio";
  if (Number(size) === 0 || encoding === "us-ascii" || encoding === "utf-8") return Number(size) <= maxEditableFileBytes ? "text" : "large-text";
  return "binary";
}
