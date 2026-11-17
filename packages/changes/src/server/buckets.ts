import { getWorkspaceInit } from "@agents-in-the-cloud/workspace";
import { effectiveChangeBuckets, workspaceTemplateIdOfInit, type ChangeBucket } from "@agents-in-the-cloud/workspace-templates";

export type { ChangeBucket };

interface CompiledPattern { glob: Bun.Glob; target: "name" | "path" }

function compile(pattern: string): CompiledPattern {
  if (pattern.endsWith("/") && !pattern.slice(0, -1).includes("/")) return { glob: new Bun.Glob(`**/${pattern}**`), target: "path" };
  if (!pattern.includes("/")) return { glob: new Bun.Glob(pattern), target: "name" };
  const anchored = pattern.replace(/^\//, "");
  return { glob: new Bun.Glob(anchored.endsWith("/") ? `${anchored}**` : anchored), target: "path" };
}

export function changeBucketMatcher(buckets: readonly ChangeBucket[]): (path: string) => number | undefined {
  const compiled = buckets.map(bucket => ({
    include: bucket.patterns.filter(pattern => !pattern.startsWith("!")).map(compile),
    exclude: bucket.patterns.filter(pattern => pattern.startsWith("!")).map(pattern => compile(pattern.slice(1))),
  }));
  const matches = (pattern: CompiledPattern, path: string) => pattern.glob.match(pattern.target === "name" ? path.slice(path.lastIndexOf("/") + 1) : path);
  return path => {
    const index = compiled.findIndex(bucket => bucket.include.some(pattern => matches(pattern, path)) && !bucket.exclude.some(pattern => matches(pattern, path)));
    return index < 0 ? undefined : index;
  };
}

export interface BucketTotals { name: string; files: number; additions: number; deletions: number }

export interface ChangeTotals { main: BucketTotals; buckets: BucketTotals[]; bucketOf: Map<string, number | undefined> }

export function bucketTotals(buckets: readonly ChangeBucket[], files: readonly { path: string; additions: number; deletions: number }[]): ChangeTotals {
  const match = changeBucketMatcher(buckets);
  const main = { name: "Main work", files: 0, additions: 0, deletions: 0 };
  const totals = buckets.map(bucket => ({ name: bucket.name, files: 0, additions: 0, deletions: 0 }));
  const bucketOf = new Map<string, number | undefined>();
  for (const file of files) {
    const index = match(file.path);
    bucketOf.set(file.path, index);
    const total = index === undefined ? main : totals[index]!;
    total.files++;
    total.additions += file.additions;
    total.deletions += file.deletions;
  }
  return { main, buckets: totals, bucketOf };
}

export async function workspaceChangeBuckets(workspaceId: string): Promise<ChangeBucket[]> {
  return await effectiveChangeBuckets(workspaceTemplateIdOfInit(await getWorkspaceInit(workspaceId)));
}
