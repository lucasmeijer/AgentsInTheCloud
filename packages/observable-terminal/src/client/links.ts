import type { TerminalBufferRow } from "@gespenst/core";
import { fileReferencesIn, type WorkspaceFileTarget } from "@agents-in-the-cloud/shared";

export type TerminalFileLink = WorkspaceFileTarget;
export interface TerminalWebLink { url: string }
export type TerminalLink = TerminalFileLink | TerminalWebLink;

function positive(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function terminalUri(uri: string): TerminalLink | undefined {
  let url: URL;
  try { url = new URL(uri); } catch { return undefined; }
  if (url.protocol === "http:" || url.protocol === "https:") return { url: url.href };
  const localFile = url.protocol === "file:" && (!url.hostname || url.hostname === "localhost");
  const agentsInTheCloudFile = url.protocol === "agents-in-the-cloud:" && url.hostname === "file";
  if (!localFile && !agentsInTheCloudFile) return undefined;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return undefined; }
  if (!path.startsWith("/") || path.includes("\0")) return undefined;
  const position = url.hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  const fragment = position ? undefined : url.hash.slice(1) || undefined;
  return { path, line: positive(url.searchParams.get("line")) ?? positive(position?.[1]), column: positive(url.searchParams.get("column")) ?? positive(position?.[2]), fragment };
}

const webReference = /https?:\/\/[^\s<>"'`]+?(?=[.,;:!?)\]}'"`]*(?:$|[\s<>"'`]))/g;

export function terminalTextLinkAt(text: string, offset: number): TerminalLink | undefined {
  for (const match of text.matchAll(webReference)) {
    if (offset >= match.index && offset < match.index + match[0].length) return terminalUri(match[0]);
  }
  for (const { start, end, ...link } of fileReferencesIn(text)) {
    if (offset >= start && offset < end) return link;
  }
  return undefined;
}

export function terminalLinkAt(row: TerminalBufferRow, column: number): TerminalLink | undefined {
  // Compute the string offset and inspect OSC 8 metadata in one pass. Cell
  // columns and JavaScript string offsets diverge for wide or Unicode text.
  let offset = 0;
  let nextColumn = 0;
  let uri: string | null | undefined;
  for (const cell of row.cells) {
    if (cell.x >= column) {
      if (cell.x === column) uri = cell.hyperlinkUri ?? uri;
      break;
    }
    offset += cell.x - nextColumn;
    if (cell.width !== "spacer-tail") offset += cell.text.length;
    nextColumn = cell.x + 1;
    if (cell.width === "wide" && cell.x + 1 === column) uri = cell.hyperlinkUri;
  }
  if (uri) return terminalUri(uri);
  return terminalTextLinkAt(row.text, offset + Math.max(0, column - nextColumn));
}
