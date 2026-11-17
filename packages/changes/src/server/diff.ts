import { extensionOf, imageMimeByExtension } from "@agents-in-the-cloud/shared/file-metadata";
import { isUtf8 } from "node:buffer";
import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from "@pierre/diffs";
import { git, parseGitStatus, parseGitNumstat, type GitStatusEntry, type GitNumstat, type Repository, type RepositoryContent } from "@agents-in-the-cloud/workspace/git";
import { maxChangesTextBytes, maxChangesTextLines } from "../editing.ts";

type ChangesFileKind = "text" | "binary" | "large" | "mode";
type ChangesFileChange = "added" | "modified" | "removed";

interface ChangesImage { contents: Buffer; contentType: string }

export interface ChangesFile {
  path: string;
  previousPath?: string;
  change: ChangesFileChange;
  kind: ChangesFileKind;
  oldContents?: string;
  newContents?: string;
  diff?: FileDiffMetadata;
  detail?: string;
  newMode?: string;
  images?: { before?: ChangesImage; after?: ChangesImage };
}

export type ChangesFileSummary = {
  path: string;
  previousPath?: string;
  change: ChangesFileChange;
  untracked?: true;
};

export type ChangesFileStats = ChangesFileSummary & ChangeCounts & { binarySizes?: { before?: number; after?: number } };

export type ChangesIndex =
  | { phase: "not-git" }
  | { phase: "ready"; files: ChangesFileSummary[] };

const maxChangesContentBytes = 16 * 1024 * 1024;
export const maxUnchangedMediaBytes = 64 * 1024 * 1024;

function decodeText(content: Buffer | undefined): string | undefined {
  if (content === undefined || content.includes(0) || !isUtf8(content)) return undefined;
  return content.toString("utf8");
}

function lineCount(text: string | undefined): number {
  if (!text) return 0;
  return text.split("\n").length;
}

type ChangeCounts = { additions: number; deletions: number };

async function modes(root: Repository, entry: GitStatusEntry): Promise<{ oldMode?: string; newMode?: string }> {
  const raw = (await git(root, ["diff", "--raw", "HEAD", "--", entry.path], true)).toString("utf8").trim();
  const match = raw.match(/^:(\d{6}) (\d{6}) /);
  if (match) return { oldMode: match[1], newMode: match[2] };
  if (entry.code === "??") {
    return { newMode: (await root.workingFile(entry.path, 0))?.mode };
  }
  return {};
}

function captureImage(path: string, contents: Buffer | undefined, mode?: string): ChangesImage | undefined {
  const contentType = imageMimeByExtension[extensionOf(path)];
  return contents !== undefined && contentType && mode !== "120000" ? { contents, contentType } : undefined;
}

function changesFileFromContents(
  entry: GitStatusEntry,
  oldContent: RepositoryContent | undefined,
  newContent: RepositoryContent | undefined,
  modes: { oldMode?: string; newMode?: string },
): ChangesFile | undefined {
  const oldPath = entry.previousPath ?? entry.path;
  const change: ChangesFileChange = oldContent === undefined ? "added" : newContent === undefined ? "removed" : "modified";
  const base: Pick<ChangesFile, "path" | "previousPath" | "change" | "newMode"> = { path: entry.path, change, newMode: modes.newMode };
  if (entry.previousPath) base.previousPath = entry.previousPath;
  if (oldContent === undefined && newContent === undefined) return undefined;
  if ((oldContent && !oldContent.contents) || (newContent && !newContent.contents)) return { ...base, kind: "large", detail: "File is too large to render safely" };
  const oldBuffer = oldContent?.contents, newBuffer = newContent?.contents;
  const before = captureImage(oldPath, oldBuffer, modes.oldMode);
  const after = captureImage(entry.path, newBuffer, modes.newMode);
  if (before || after) return { ...base, kind: "binary", images: { before, after } };
  const oldText = decodeText(oldBuffer);
  const newText = decodeText(newBuffer);
  if ((oldBuffer && oldText === undefined) || (newBuffer && newText === undefined)) return { ...base, kind: "binary", detail: "Binary file changed" };
  if ((oldBuffer?.byteLength ?? 0) > maxChangesTextBytes || (newBuffer?.byteLength ?? 0) > maxChangesTextBytes || lineCount(oldText) > maxChangesTextLines || lineCount(newText) > maxChangesTextLines) return { ...base, kind: "large", detail: "File is too large to render safely" };
  const oldFile: FileContents | null = oldBuffer === undefined ? null : { name: oldPath, contents: oldText ?? "" };
  const newFile: FileContents | null = newBuffer === undefined ? null : { name: entry.path, contents: newText ?? "" };
  const diff = parseDiffFromFile(oldFile, newFile, { context: 3 });
  return diff.hunks.length
    ? { ...base, kind: "text", oldContents: oldText, newContents: newText, diff }
    : { ...base, oldContents: oldText, newContents: newText, kind: "mode", detail: entry.previousPath ? "File renamed"
      : oldBuffer === undefined ? "Empty file added"
      : newBuffer === undefined ? "Empty file deleted"
      : modes.oldMode !== modes.newMode ? "File mode changed" : "No textual changes" };
}

function isNestedRepository(entry: GitStatusEntry): boolean {
  return entry.code === "??" && entry.path.endsWith("/");
}

async function changesFile(root: Repository, entry: GitStatusEntry): Promise<ChangesFile | undefined> {
  if (isNestedRepository(entry)) return { path: entry.path, change: "added", kind: "mode", detail: "Nested Git repository" };
  const oldPath = entry.previousPath ?? entry.path;
  const [oldContent, newContent, fileModes] = await Promise.all([
    entry.code === "??" ? undefined : root.blob(`HEAD:${oldPath}`, maxChangesContentBytes),
    root.workingFile(entry.path, maxChangesContentBytes),
    modes(root, entry),
  ]);
  if (oldContent === undefined && newContent === undefined && (fileModes.oldMode === "160000" || fileModes.newMode === "160000")) {
    const base = { path: entry.path, change: "modified" as const };
    return entry.previousPath ? { ...base, previousPath: entry.previousPath, kind: "mode", detail: "Submodule changed" } : { ...base, kind: "mode", detail: "Submodule changed" };
  }
  return changesFileFromContents(entry, oldContent, newContent, fileModes);
}

async function statusEntries(root: Repository): Promise<GitStatusEntry[] | undefined> {
  const [inside, status] = await Promise.all([
    git(root, ["rev-parse", "--is-inside-work-tree"], true),
    root.gitResult(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  if (inside.toString("utf8").trim() !== "true") return undefined;
  if (status.exitCode !== 0) throw new Error(status.stderr.trim() || "git status failed");
  return parseGitStatus(status.stdout);
}

function statusChange(entry: GitStatusEntry): ChangesFileChange {
  if (entry.code === "??" || entry.code.includes("A")) return "added";
  if (entry.code.includes("D")) return "removed";
  return "modified";
}

export async function collectChangesIndex(root: Repository): Promise<ChangesIndex> {
  const entries = await statusEntries(root);
  if (!entries) return { phase: "not-git" };
  const files = entries.map((entry): ChangesFileSummary => {
    const file: ChangesFileSummary = { path: entry.path, change: statusChange(entry) };
    if (entry.previousPath) file.previousPath = entry.previousPath;
    if (entry.code === "??") file.untracked = true;
    return file;
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { phase: "ready", files };
}

export async function collectChangesFile(root: Repository, path: string): Promise<ChangesFile | undefined> {
  const entries = await statusEntries(root);
  const entry = entries?.find((candidate) => candidate.path === path);
  return entry ? await changesFile(root, entry) : undefined;
}

export async function collectChangesStats(root: Repository, index: ChangesIndex): Promise<ChangesFileStats[]> {
  if (index.phase !== "ready") return [];
  let tracked = new Map<string, GitNumstat>();
  if (index.files.some((file) => !file.untracked)) {
    const head = await git(root, ["rev-parse", "--verify", "HEAD"], true);
    const base = head.byteLength ? "HEAD" : (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).toString("utf8").trim();
    tracked = parseGitNumstat(await git(root, ["diff", "--numstat", "-z", base, "--"]));
  }
  return Promise.all(index.files.map(async (file) => {
    if (file.untracked) {
      const content = await root.workingFile(file.path, maxChangesTextBytes);
      const text = decodeText(content?.contents);
      if (content !== undefined && text === undefined) {
        return { ...file, additions: 0, deletions: 0, binarySizes: { after: content.size } };
      }
      const additions = text ? lineCount(text) - Number(text.endsWith("\n")) : 0;
      return { ...file, additions, deletions: 0 };
    }
    const { binary, ...counts } = tracked.get(file.path) ?? { additions: 0, deletions: 0 };
    if (binary) {
      const [before, after] = await Promise.all([
        root.blob(`HEAD:${file.previousPath ?? file.path}`, 0),
        root.workingFile(file.path, 0),
      ]);
      return { ...file, ...counts, binarySizes: { before: before?.size, after: after?.size } };
    }
    return { ...file, ...counts };
  }));
}


interface CommitEntry extends GitStatusEntry {
  oldMode: string;
  newMode: string;
  oldHash: string;
  newHash: string;
}

async function commitEntries(root: Repository, commit: string): Promise<{ base: string; entries: CommitEntry[] }> {
  const [, parent] = (await git(root, ["rev-list", "--parents", "-n", "1", commit])).toString("utf8").trim().split(" ");
  const base = parent ?? (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).toString("utf8").trim();
  return { base, entries: await comparisonEntries(root, base, commit) };
}

async function comparisonEntries(root: Repository, base: string, end?: string): Promise<CommitEntry[]> {
  const fields = (await git(root, ["diff", "--raw", "--no-abbrev", "-z", "-M", base, ...(end ? [end] : []), "--"])).toString("utf8").split("\0");
  const entries: CommitEntry[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const [oldMode, newMode, oldHash, newHash, code] = fields[index++]!.slice(1).split(" ");
    const path = fields[index++]!;
    const entry: CommitEntry = { code: code!, path, oldMode: oldMode!, newMode: newMode!, oldHash: oldHash!, newHash: newHash! };
    if (code!.startsWith("R") || code!.startsWith("C")) {
      entry.previousPath = path;
      entry.path = fields[index++]!;
    }
    entries.push(entry);
  }
  return entries;
}

export async function collectCommitChangesStats(root: Repository, commit: string): Promise<ChangesFileStats[]> {
  const { base, entries } = await commitEntries(root, commit);
  const stats = parseGitNumstat(await git(root, ["diff", "--numstat", "-z", "-M", base, commit, "--"]));
  return Promise.all(entries.map(async (entry) => {
    const { binary, ...counts } = stats.get(entry.path)!;
    const file: ChangesFileStats = { path: entry.path, change: statusChange(entry), ...counts };
    if (entry.previousPath) file.previousPath = entry.previousPath;
    if (binary) {
      const size = async (hash: string, mode: string) => mode === "000000" ? undefined : Number((await git(root, ["cat-file", "-s", hash])).toString("utf8"));
      const [before, after] = await Promise.all([size(entry.oldHash, entry.oldMode), size(entry.newHash, entry.newMode)]);
      file.binarySizes = { before, after };
    }
    return file;
  }));
}

export async function collectCommitChangesFile(root: Repository, commit: string, path: string): Promise<ChangesFile | undefined> {
  const { entries } = await commitEntries(root, commit);
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) return undefined;
  if (entry.oldMode === "160000" || entry.newMode === "160000") {
    return { path, change: statusChange(entry), kind: "mode", detail: "Submodule changed" };
  }
  const contents = (hash: string, mode: string) => mode === "000000" ? undefined : root.blob(hash, maxChangesContentBytes);
  const [before, after] = await Promise.all([contents(entry.oldHash, entry.oldMode), contents(entry.newHash, entry.newMode)]);
  return changesFileFromContents(entry, before, after, entry);
}

export async function collectChangesComparison(root: Repository, base: string, end?: string): Promise<{ index: ChangesIndex; stats: ChangesFileStats[]; files: Map<string, ChangesFile> }> {
  const [entries, status, numstat] = await Promise.all([
    comparisonEntries(root, base, end),
    end ? undefined : statusEntries(root),
    git(root, ["diff", "--numstat", "-z", "-M", base, ...(end ? [end] : []), "--"]),
  ]);
  if (!end) {
    const untracked = status!.filter((entry) => entry.code === "??" && !entries.some((tracked) => tracked.path === entry.path));
    for (const entry of untracked) entries.push({ ...entry, oldMode: "000000", newMode: "100644", oldHash: "", newHash: "" });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const counts = parseGitNumstat(numstat);
  const files = new Map<string, ChangesFile>();
  const stats: ChangesFileStats[] = new Array(entries.length);
  await Promise.all(entries.map(async (entry, position) => {
    const summary: ChangesFileSummary = { path: entry.path, change: statusChange(entry) };
    if (entry.previousPath) summary.previousPath = entry.previousPath;
    if (entry.code === "??") summary.untracked = true;
    if (entry.oldMode === "160000" || entry.newMode === "160000") {
      files.set(entry.path, { ...summary, kind: "mode", detail: "Submodule changed" });
      stats[position] = { ...summary, additions: 0, deletions: 0 };
      return;
    }
    if (isNestedRepository(entry)) {
      files.set(entry.path, { ...summary, kind: "mode", detail: "Nested Git repository" });
      stats[position] = { ...summary, additions: 0, deletions: 0 };
      return;
    }
    const blob = (hash: string, mode: string) => mode === "000000" ? undefined : root.blob(hash, maxChangesContentBytes);
    const [before, working, committed] = await Promise.all([blob(entry.oldHash, entry.oldMode), end ? undefined : root.workingFile(entry.path, maxChangesContentBytes), end ? blob(entry.newHash, entry.newMode) : undefined]);
    const after = end ? committed : working;
    if (working) entry.newMode = working.mode;
    if (!entry.previousPath && before?.contents && after?.contents && before.contents.equals(after.contents) && entry.oldMode === entry.newMode) return;
    const file = changesFileFromContents(entry, before, after, entry);
    if (!file) throw new Error(`File changed while capturing comparison: ${entry.path}`);
    summary.change = file.change;
    files.set(entry.path, file);
    const count = counts.get(entry.path);
    const afterText = decodeText(after?.contents);
    stats[position] = { ...summary, additions: count?.additions ?? (lineCount(afterText) - Number(afterText?.endsWith("\n") ?? false)), deletions: count?.deletions ?? 0 };
    if (file.diff) {
      stats[position] = { ...summary, additions: file.diff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0), deletions: file.diff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0) };
    }
    const unread = (before !== undefined && !before.contents) || (after !== undefined && !after.contents);
    if (file.kind === "binary" || (unread && !count)) stats[position] = { ...summary, additions: 0, deletions: 0, binarySizes: { before: before?.size, after: after?.size } };
  }));
  const capturedStats = stats.filter((stat) => stat !== undefined);
  return { index: { phase: "ready", files: capturedStats.map(({ additions: _a, deletions: _d, binarySizes: _b, ...summary }) => summary) }, stats: capturedStats, files };
}

export async function collectUnchangedPaths(root: Repository, target: string | undefined, changed: ReadonlySet<string>): Promise<string[]> {
  const records = (output: Buffer) => output.toString("utf8").split("\0").filter(Boolean);
  let paths: string[];
  if (target) {
    paths = records(await git(root, ["ls-tree", "-r", "-z", "--full-tree", target])).filter(record => record.split(" ")[1] === "blob").map(record => record.slice(record.indexOf("\t") + 1));
  } else {
    const [indexed, deleted] = await Promise.all([git(root, ["ls-files", "-z", "--stage"]), git(root, ["ls-files", "-z", "--deleted"])]);
    const missing = new Set(records(deleted));
    paths = [...new Set(records(indexed).filter(record => !record.startsWith("160000 ")).map(record => record.slice(record.indexOf("\t") + 1)))].filter(path => !missing.has(path));
  }
  return paths.filter(path => !changed.has(path)).sort((a, b) => a.localeCompare(b));
}

export type UnchangedFile =
  | { kind: "text"; text: string; mode?: string }
  | { kind: "image" | "video" | "audio"; contentType: string }
  | { kind: "binary" | "large" };

export function unchangedMediaType(path: string): string | undefined {
  const contentType = imageMimeByExtension[extensionOf(path)] ?? Bun.file(path).type.split(";")[0]!;
  return /^(?:image|video|audio)\//.test(contentType) ? contentType : undefined;
}

export async function readUnchangedContents(root: Repository, target: string | undefined, path: string, maxBytes: number): Promise<RepositoryContent & { mode?: string }> {
  const file = target ? await root.blob(`${target}:${path}`, maxBytes) : await root.workingFile(path, maxBytes);
  if (!file) throw new Error(`${path} no longer exists`);
  return file;
}

export async function readUnchangedFile(root: Repository, target: string | undefined, path: string): Promise<UnchangedFile> {
  const contentType = unchangedMediaType(path);
  if (contentType) {
    // SAFETY: unchangedMediaType only returns image, video and audio types.
    const kind = contentType.split("/")[0] as "image" | "video" | "audio";
    return { kind, contentType };
  }
  const { contents, mode } = await readUnchangedContents(root, target, path, maxChangesTextBytes);
  if (!contents) return { kind: "large" };
  const text = decodeText(contents);
  if (text === undefined) return { kind: "binary" };
  if (contents.byteLength > maxChangesTextBytes || lineCount(text) > maxChangesTextLines) return { kind: "large" };
  return { kind: "text", text, mode };
}
