export interface WorkspaceFileTarget {
  path: string;
  line?: number;
  column?: number;
  fragment?: string;
}

function positiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseWorkspaceFileTarget(params: URLSearchParams): WorkspaceFileTarget {
  return {
    path: params.get("path") ?? "",
    line: positiveInteger(params.get("line")),
    column: positiveInteger(params.get("column")),
    fragment: params.get("fragment") || undefined,
  };
}

// File-shaped plain text: an optional /, ./ or ../ prefix, folders, and a name with a
// letter-led extension, then an optional :line, :line:column or #anchor.
const fileReferenceSource = String.raw`((?:\/|\.\.?\/)?(?:[^\s<>:"'\`()[\]{},;!?/]+\/)*[^\s<>:"'\`()[\]{},;!?/]+\.[a-zA-Z][\w+-]*)(?::(\d+)(?::(\d+))?|#([\w-]+))?`;
const embeddedFileReference = new RegExp(String.raw`(?:^|[\s([\`'"=])${fileReferenceSource}(?=$|[\s.)\]}'"\`,;!?])`, "g");
const wholeFileReference = new RegExp(`^${fileReferenceSource}$`);

export interface FileReference extends WorkspaceFileTarget {
  start: number;
  end: number;
}

function fileReference(match: RegExpMatchArray): FileReference {
  const path = match[1]!;
  const start = match.index! + match[0].indexOf(path);
  return { path, line: positiveInteger(match[2] ?? null), column: positiveInteger(match[3] ?? null), fragment: match[4], start, end: match.index! + match[0].length };
}

export function* fileReferencesIn(text: string): Generator<FileReference> {
  for (const match of text.matchAll(embeddedFileReference)) yield fileReference(match);
}

export function parseFileReference(text: string): FileReference | undefined {
  const match = text.match(wholeFileReference);
  return match ? fileReference(match) : undefined;
}

export function workspaceFileOpenUrl(workspaceId: string, path: string, position: Omit<WorkspaceFileTarget, "path"> = {}, filesViewId?: string): string {
  const query = new URLSearchParams({ path });
  if (position.line) query.set("line", String(position.line));
  if (position.column) query.set("column", String(position.column));
  if (position.fragment) query.set("fragment", position.fragment);
  if (filesViewId) query.set("filesView", filesViewId);
  const endpoint = filesViewId ? "files-view/open" : "file/open";
  return `/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}?${query}`;
}
