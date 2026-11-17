import type { ChangesCommit } from "./history-model.ts";
export interface AncestryEdge { from: string; to: string }

export type ComparisonCommit = Pick<ChangesCommit, "id" | "parents">;
export interface DiffEndpoints { target: string; base?: string | null }
export interface ResolvedDiffEndpoints {
  base: string | null;
  target: string;
  implicitBase: boolean;
  path: string[];
  trace: AncestryEdge[];
  selectedRows: string[];
}
function reachable(origin: string, next: (id: string) => readonly string[]): Set<string> {
  const visited = new Set<string>(), stack = [origin];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...next(id));
  }
  return visited;
}

/**
 * Two snapshot endpoints, not an inclusive commit range. A merge selected alone
 * uses its FIRST parent; an explicit pair compares exactly those two snapshots.
 * Ancestry determines their direction, independently of input order.
 *
 * Highlight ALL connecting routes: ancestors(Target) ∩ descendants(Base), minus
 * Base. This is not "all commits contributing changes": a merge edge can carry
 * changes authored outside those routes. Disconnected pairs have no path.
 *
 * `commits` is known topology. `loaded` projects it onto a paged history; outgoing
 * highlighted edges may continue off-page only when real connectivity is known.
 * All loaded commits remain visible; selection only changes their visual roles.
 * Unknown ancestry never fabricates a route.
 */
export function resolveDiffEndpoints(commits: readonly ComparisonCommit[], endpoints: DiffEndpoints, loaded = commits.map(commit => commit.id)): ResolvedDiffEndpoints {
  const byId = new Map(commits.map(commit => [commit.id, commit]));
  if (endpoints.base === endpoints.target) throw new RangeError("Select two different snapshots.");
  let target = endpoints.target;
  let base = endpoints.base === undefined ? byId.get(target)?.parents[0] ?? null : endpoints.base;
  let ancestors = reachable(target, id => byId.get(id)?.parents ?? []);
  if (base !== null && !ancestors.has(base)) {
    const otherAncestors = reachable(base, id => byId.get(id)?.parents ?? []);
    // Ancestry, not click order or row position, determines the direction.
    // Unrelated snapshots have no ancestry direction. Keep their order stable
    // in the captured history (also keeping synthetic working state on Target).
    const targetRow = commits.findIndex(commit => commit.id === target), baseRow = commits.findIndex(commit => commit.id === base);
    if (otherAncestors.has(target) || (targetRow !== -1 && baseRow !== -1 && targetRow > baseRow)) {
      [base, target] = [target, base];
      ancestors = otherAncestors;
    }
  }
  if (!byId.has(target) || !loaded.includes(target)) throw new RangeError("Target must be in the loaded history");
  const children = new Map<string, string[]>();
  for (const commit of commits) for (const parent of commit.parents) {
    const descendants = children.get(parent) ?? [];
    descendants.push(commit.id);
    children.set(parent, descendants);
  }
  const connected = base === null || ancestors.has(base);
  const descendants = base === null ? ancestors : reachable(base, id => children.get(id) ?? []);
  const corridor = new Set(connected ? [...ancestors].filter(id => descendants.has(id)) : []);
  const path = commits.filter(commit => corridor.has(commit.id) && commit.id !== base).map(commit => commit.id);
  const pathIds = new Set(path), loadedIds = new Set(loaded);
  const trace = commits.flatMap(commit => loadedIds.has(commit.id) && pathIds.has(commit.id)
    ? commit.parents.filter(parent => corridor.has(parent)).map(parent => ({ from: commit.id, to: parent })) : []);
  const selectedRows = loaded.filter(id => id === target || (endpoints.base !== undefined && id === base));
  return { base, target, implicitBase: endpoints.base === undefined, path, trace, selectedRows };
}
