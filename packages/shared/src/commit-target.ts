/**
 * Git's `A..B`: the comparison from snapshot A to snapshot B; without a base, a single snapshot.
 * Endpoints are `working` and `staged` (the live snapshots) or an abbreviated commit hash, optionally `^` for its first parent.
 */
export interface CommitLinkTarget {
  base?: string;
  target: string;
}

export const commitLinkPrefix = "agents-in-the-cloud://commit/";
const endpointPattern = /^(?:[0-9a-f]{7,40}\^?|working|staged)$/;

export const isCommitHash = (endpoint: string): boolean => endpoint !== "working" && endpoint !== "staged";
export const shortCommit = (hash: string): string => `${hash.slice(0, 7)}${hash.endsWith("^") ? "^" : ""}`;

export function parseCommitLinkSpec(spec: string): CommitLinkTarget | undefined {
  const [base, target, ...rest] = spec.toLowerCase().split("..");
  if (rest.length || ![base, target].every(part => part === undefined || endpointPattern.test(part)) || base === target) return undefined;
  return target === undefined ? { target: base! } : { base, target };
}

export function parseCommitLinkHref(href: string): CommitLinkTarget | undefined {
  return href.startsWith(commitLinkPrefix) ? parseCommitLinkSpec(href.slice(commitLinkPrefix.length).replaceAll(/%5e/gi, "^")) : undefined;
}

export function changesCommitUrl(workspaceId: string, endpoint: "open" | "commit-label", { base, target }: CommitLinkTarget): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/changes/${endpoint}?${new URLSearchParams({ commit: base === undefined ? target : `${base}..${target}` })}`;
}
