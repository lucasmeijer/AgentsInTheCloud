import { resolveDiffEndpoints } from "../diff-endpoints.ts";
import { captureSyntheticStats } from "./synthetic-stats.ts";
import { collectChangesComparison, collectChangesIndex, type ChangesFile, type ChangesFileStats, type ChangesIndex } from "./diff.ts";
import { git, type Repository } from "@agents-in-the-cloud/workspace/git";
import { endpointName, diffEndpointsDescription, stagedChanges, workingTree, type ChangesCommit, type DiffEndpoints, type HistoryModel } from "../history.ts";
export { stagedChanges, workingTree } from "../history.ts";
export type { ChangesCommit, DiffEndpoints } from "../history.ts";

export interface ChangesHistory extends HistoryModel {
  id: string;
  tips: string[];
  indexTree: string;
  emptyTree: string;
  upstreamId?: string;
  hasStaged: boolean;
  aheadIds: Set<string>;
  hasMore: boolean;
  loaded: number;
  phase: ChangesIndex["phase"];
}
export interface ChangesSnapshot {
  id: string;
  index: ChangesIndex;
  stats: ChangesFileStats[];
  files: Map<string, ChangesFile>;
  history: ChangesHistory;
  endpoints: DiffEndpoints;
  label: string;
  base?: string;
  baseLabel: string;
  target?: string;
  targetLabel: string;
  notice?: string;
}
export class InvalidDiffEndpoints extends Error {}

const commitFormat = "%H%x00%P%x00%s%x00%an%x00%cs%x00%b%x1e";
function commitRecords(history: ChangesHistory, output: Buffer): ChangesCommit[] {
  return output.toString("utf8").split("\x1e").map(record => record.replace(/^\n/, "")).filter(Boolean).map(record => {
    const [id, parents, subject, author, date, body] = record.split("\0");
    return { id: id!, parents: parents ? parents.split(" ") : [], subject: subject!, body: body!.trim(), author: author!, date: date!, refs: history.references.filter(ref => ref.id === id), ahead: history.aheadIds.has(id!), kind: "commit" };
  });
}

export async function commitHistory(root: Repository, history: ChangesHistory, skip = 0, limit = 50): Promise<{ commits: ChangesCommit[]; hasMore: boolean }> {
  if (!history.tips.length) return { commits: [], hasMore: false };
  const commits = commitRecords(history, await git(root, ["log", "--topo-order", `--skip=${skip}`, `--max-count=${limit + 1}`, `--format=${commitFormat}`, ...history.tips, "--"]));
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

export async function loadHistoryThrough(root: Repository, history: ChangesHistory, ids: readonly (string | null | undefined)[]): Promise<void> {
  const commits = history.topology.filter(commit => commit.id !== workingTree && commit.id !== stagedChanges).map(commit => commit.id);
  for (;;) {
    const missing = ids.filter(id => id != null && !history.commits.some(commit => commit.id === id)).map(id => commits.indexOf(id!)).filter(row => row >= 0);
    if (!missing.length || !history.hasMore) return;
    const page = await commitHistory(root, history, history.loaded, Math.max(50, Math.max(...missing) + 1 - history.loaded));
    history.commits.push(...page.commits);
    history.loaded += page.commits.length;
    history.hasMore = page.hasMore;
  }
}

export async function captureHistory(root: Repository): Promise<ChangesHistory> {
  const index = await collectChangesIndex(root);
  const history: ChangesHistory = { id: crypto.randomUUID(), commits: [], topology: [], tips: [], references: [], indexTree: "", emptyTree: "", aheadIds: new Set(), endpoints: { target: workingTree }, hasStaged: false, hasMore: false, loaded: 0, phase: index.phase };
  if (index.phase !== "ready") return history;
  const [head, branch, refs, emptyTree, indexTree] = await Promise.all([
    git(root, ["rev-parse", "--verify", "HEAD"], true),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true),
    git(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(upstream)"]),
    git(root, ["hash-object", "-t", "tree", "/dev/null"]),
    root.captureIndexTree(),
  ]);
  history.head = head.toString().trim() || undefined;
  history.branch = branch.toString().trim() || undefined;
  history.emptyTree = emptyTree.toString().trim();
  history.indexTree = indexTree.toString().trim();
  const refIds = new Map<string, string>();
  let upstreamRef: string | undefined;
  for (const line of refs.toString().trimEnd().split("\n")) {
    if (!line) continue;
    const [ref, hash, peeled, upstreamName, upstream] = line.split("\0");
    refIds.set(ref!, hash!);
    if (ref === `refs/heads/${history.branch}` && upstreamName) {
      history.upstream = upstreamName;
      upstreamRef = upstream;
    }
    if (!/^refs\/(heads|remotes|tags)\//.test(ref!)) continue;
    const kind = ref!.startsWith("refs/heads/") ? "local" : ref!.startsWith("refs/remotes/") ? "remote" : "tag";
    const name = ref!.replace(/^refs\/(heads|remotes|tags)\//, "");
    if (kind === "remote" && name.endsWith("/HEAD")) continue;
    history.references.push({ name, kind, id: peeled || hash! });
  }
  history.tips = [...new Set([...(history.head ? [history.head] : []), ...history.references.filter(ref => ref.kind === "local").map(ref => ref.id)])];
  history.upstreamId = upstreamRef ? refIds.get(upstreamRef) : undefined;
  if (!history.upstreamId) history.upstream = undefined;
  const [syntheticStats, ahead, pageOutput, topologyOutput] = await Promise.all([
    captureSyntheticStats(root, history.head ?? history.emptyTree, history.indexTree, index.files),
    history.head && history.upstreamId ? git(root, ["rev-list", "--topo-order", history.head, "--not", history.upstreamId, "--"]) : Buffer.alloc(0),
    history.tips.length ? git(root, ["log", "--topo-order", "--max-count=9", `--format=${commitFormat}`, ...history.tips, "--"]) : Buffer.alloc(0),
    history.tips.length ? git(root, ["rev-list", "--topo-order", "--parents", ...history.tips, "--"]) : Buffer.alloc(0),
  ]);
  history.hasStaged = syntheticStats.staged.files > 0;
  history.aheadIds = new Set(ahead.toString().trim().split("\n").filter(Boolean));
  const synthetic = (id: string, kind: "working" | "staged", subject: string, parents: string[]): ChangesCommit => ({ id, kind, subject, parents, author: "You", date: "Now", refs: [], ahead: false, stats: syntheticStats[kind] });
  history.commits.push(synthetic(workingTree, "working", "Working tree", history.hasStaged ? [stagedChanges] : history.head ? [history.head] : []));
  if (history.hasStaged) history.commits.push(synthetic(stagedChanges, "staged", "Staged changes", history.head ? [history.head] : []));
  history.endpoints = { target: workingTree, base: history.head ?? null };
  if (history.aheadIds.size) {
    const base = (await git(root, ["merge-base", history.head!, history.upstreamId!])).toString().trim();
    history.unpushed = { base, count: history.aheadIds.size };
    history.endpoints = { target: workingTree, base: base };
  }
  history.topology = [...history.commits.map(({ id, parents }) => ({ id, parents })), ...topologyOutput.toString().trim().split("\n").filter(Boolean).map(line => {
    const [id, ...parents] = line.split(" ");
    return { id: id!, parents };
  })];
  const commits = commitRecords(history, pageOutput);
  history.commits.push(...commits.slice(0, 8));
  history.loaded = Math.min(commits.length, 8);
  history.hasMore = commits.length > 8;
  return history;
}

export async function captureChanges(root: Repository, endpoints?: DiffEndpoints, capturedHistory?: ChangesHistory): Promise<ChangesSnapshot> {
  const history = capturedHistory ?? await captureHistory(root);
  endpoints ??= history.endpoints;
  const snapshot: ChangesSnapshot = { id: crypto.randomUUID(), index: { phase: "not-git" }, stats: [], files: new Map(), history, endpoints, label: "Changes", baseLabel: "", targetLabel: "" };
  if (history.phase !== "ready") return snapshot;
  // Only pinned IDs from this history may reach Git. The full compact topology
  // makes direction and ALL connecting routes independent of history paging.
  if (!history.commits.some(commit => commit.id === endpoints.target) || (endpoints.base != null && !history.topology.some(commit => commit.id === endpoints.base))) throw new InvalidDiffEndpoints("These endpoints aren’t in this history. Refresh Changes.");
  let selected;
  try { selected = resolveDiffEndpoints(history.topology, endpoints, history.commits.map(commit => commit.id)); }
  catch (error) { if (!(error instanceof RangeError)) throw error; throw new InvalidDiffEndpoints(error.message); }
  snapshot.endpoints = { target: selected.target };
  if (endpoints.base !== undefined) snapshot.endpoints.base = selected.base;
  snapshot.base = selected.base === null ? history.emptyTree : selected.base === stagedChanges ? history.indexTree : selected.base;
  snapshot.target = selected.target === workingTree ? undefined : selected.target === stagedChanges ? history.indexTree : selected.target;
  snapshot.baseLabel = snapshot.base === history.emptyTree ? "Empty tree" : snapshot.base === history.indexTree ? "Staged changes" : endpointName(history, selected.base ?? undefined);
  snapshot.targetLabel = endpointName(history, selected.target);
  snapshot.label = diffEndpointsDescription(history, selected);
  const comparison = await collectChangesComparison(root, snapshot.base, snapshot.target);
  snapshot.index = comparison.index;
  snapshot.stats = comparison.stats;
  snapshot.files = comparison.files;
  for (const file of snapshot.files.values()) if (file.diff) file.diff.cacheKey = `${snapshot.id}:${file.path}`;
  return snapshot;
}
