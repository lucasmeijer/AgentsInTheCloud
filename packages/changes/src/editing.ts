import type { ChangesFile } from "./server/diff.ts";

export const maxChangesTextBytes = 1_000_000;
export const maxChangesTextLines = 5_000;
export type EditLineEnding = "lf" | "crlf";

export function editLineEnding(contents: string): EditLineEnding | undefined {
  if (/\r(?!\n)/.test(contents)) return undefined;
  const crlf = contents.includes("\r\n");
  if (crlf && /(?<!\r)\n/.test(contents)) return undefined;
  return crlf ? "crlf" : "lf";
}

export function canEditFile(file: ChangesFile): boolean {
  return (file.newMode === "100644" || file.newMode === "100755")
    && file.newContents !== undefined && editLineEnding(file.newContents) !== undefined;
}

export function editorContents(contents: string): string { return contents.replaceAll("\r\n", "\n"); }
export function diskContents(contents: string, ending: EditLineEnding): string {
  const normalized = editorContents(contents);
  return ending === "crlf" ? normalized.replaceAll("\n", "\r\n") : normalized;
}

export interface EditedCommentRange { id: string; revision: number; start: number; end: number }
export interface EditModel { token: string; path: string; contents: string; ending: EditLineEnding }
