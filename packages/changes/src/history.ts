import { resolveDiffEndpoints, type DiffEndpoints, type ComparisonCommit, type ResolvedDiffEndpoints } from "./diff-endpoints.ts";
import { workingTree, stagedChanges, type ChangesCommit, type ChangesRef, type HistoryGraph, type GraphNode, type GraphEdge, type HistoryModel } from "./history-model.ts";
export * from "./history-model.ts";

export const rowHeight = 36;
const laneWidth = 16;
const x = (lane: number) => 12 + lane * laneWidth;
const y = (row: number) => row * rowHeight + rowHeight / 2;

export function historyGraph(commits: ChangesCommit[]): HistoryGraph {
  const byCommit = new Map(commits.map(commit => [commit.id, commit]));
  const primary = new Set<string>();
  for (let id: string | undefined = commits[0]?.id; id; id = byCommit.get(id)?.parents[0]) primary.add(id);
  const lanes: (string | undefined)[] = [];
  const nodes: GraphNode[] = [];
  const pending: { from: GraphNode; to: string; lane: number }[] = [];
  const vacant = () => { const slot = lanes.indexOf(undefined, 1); return slot === -1 ? Math.max(1, lanes.length) : slot; };
  let maximumLane = 0;
  for (const [row, commit] of commits.entries()) {
    let lane = primary.has(commit.id) ? 0 : lanes.indexOf(commit.id);
    if (lane === -1) lane = vacant();
    const node = { commit, row, lane };
    nodes.push(node);
    for (const [index, pendingId] of lanes.entries()) if (pendingId === commit.id) lanes[index] = undefined;
    for (const [index, parent] of commit.parents.entries()) {
      let parentLane = primary.has(parent) ? 0 : lanes.indexOf(parent);
      if (parentLane === 0) lanes[primary.has(commit.id) ? 0 : lane] = parent;
      if (parentLane === -1) {
        parentLane = index === 0 && lanes[lane] === undefined ? lane : vacant();
        lanes[parentLane] = parent;
      }
      maximumLane = Math.max(maximumLane, lane, parentLane);
      pending.push({ from: node, to: parent, lane: parentLane });
    }
  }
  const byId = new Map(nodes.map(node => [node.commit.id, node]));
  const height = commits.length * rowHeight;
  const edges = pending.map(({ from, to, lane }): GraphEdge => {
    const parent = byId.get(to);
    const xx = x(from.lane), px = x(parent?.lane ?? (lane < from.lane ? from.lane : lane)), yy = y(from.row), py = parent ? y(parent.row) : height;
    const bend = Math.min(28, py - yy);
    const d = xx === px ? `M ${xx} ${yy} L ${px} ${py}`
      : px < xx ? `M ${xx} ${yy} L ${xx} ${py - bend} C ${xx} ${py - bend + 10} ${px} ${py - bend + 10} ${px} ${py - 8} L ${px} ${py}`
      : `M ${xx} ${yy} L ${xx} ${yy + 8} C ${xx} ${yy + bend - 10} ${px} ${yy + bend - 10} ${px} ${yy + bend} L ${px} ${py}`;
    return { from: from.commit.id, to, d, lane: from.lane };
  });
  return { nodes, edges, width: Math.max(64, x(maximumLane) + 16), height };
}

export function endpointName(model: Pick<HistoryModel, "references">, id: string | undefined): string {
  if (!id) return "Empty tree";
  if (id === workingTree) return "Working tree";
  if (id === stagedChanges) return "Staged changes";
  const refs = model.references.filter(ref => ref.id === id);
  return refs.find(ref => ref.kind === "local")?.name ?? refs.find(ref => ref.kind === "remote")?.name ?? refs.find(ref => ref.kind === "tag")?.name ?? id.slice(0, 7);
}

export function diffEndpointsDescription(model: HistoryModel, selected: ResolvedDiffEndpoints): string {
  if (model.unpushed && selected.target === workingTree && selected.base === model.unpushed.base) return `Unpushed changes · ${model.unpushed.count} ${model.unpushed.count === 1 ? "commit" : "commits"}`;
  if (selected.target === workingTree && selected.base === (model.head ?? null)) return model.branch ? `Uncommitted changes · ${model.branch}` : "Uncommitted changes";
  if (selected.target === workingTree && selected.base === stagedChanges) return "Unstaged changes";
  if (selected.target === stagedChanges && selected.base === (model.head ?? null)) return "Staged changes";
  if (selected.implicitBase) {
    const commit = model.commits.find(commit => commit.id === selected.target)!;
    return `${endpointName(model, selected.target)} · ${commit.subject}`;
  }
  return `${endpointName(model, selected.base ?? undefined)} → ${endpointName(model, selected.target)}`;
}

export function branchColor(name: string, kind: ChangesRef["kind"] = "local"): number {
  const key = kind === "remote" ? name.slice(name.indexOf("/") + 1) : name;
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return (hash >>> 0) % 8;
}

export function comparisonGraph(graph: HistoryGraph, endpoints: DiffEndpoints, topology: readonly ComparisonCommit[] = graph.nodes.map(node => node.commit)) {
  const selection = resolveDiffEndpoints(topology, endpoints, graph.nodes.map(node => node.commit.id));
  const keys = new Set(selection.trace.map(edge => JSON.stringify([edge.from, edge.to])));
  const route = graph.edges.filter(edge => keys.has(JSON.stringify([edge.from, edge.to]))).map(edge => edge.d).join(" ");
  return { ...selection, route };
}
