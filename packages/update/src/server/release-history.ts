import { Type, type TSchema, type Static } from "typebox";
import { Value } from "typebox/value";
import { type HttpFetcher } from "./registry.ts";
import { githubRepository } from "@agents-in-the-cloud/shared/publishing";

export const releaseTagPrefix = "stable-";
const marker = "agents-in-the-cloud-release";
const recordSchema = Type.Object({
  id: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$" }),
  revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  notesRevision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
  digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  notesPath: Type.String(),
});
export type ReleaseRecord = Static<typeof recordSchema>;
export interface PublishedRelease extends ReleaseRecord { notes: string; publishedAt: string; }

export function releaseBody(record: ReleaseRecord, notes: string): string {
  Value.Assert(recordSchema, record);
  return `${notes.trim()}\n\n<!-- ${marker} ${JSON.stringify(record)} -->\n`;
}

export function parseReleaseBody(body: string) {
  const match = body.match(new RegExp(`\\n\\n<!-- ${marker} (.+) -->\\s*$`));
  if (!match) throw new Error("Stable release is missing its publication record");
  const record = Value.Parse(recordSchema, JSON.parse(match[1]!));
  if (record.notesPath !== `release_notes/${record.id}.md`) throw new Error("Stable release notes path does not match its ID");
  return { record, notes: body.slice(0, match.index).trim() };
}

const githubReleaseSchema = Type.Object({ tag_name: Type.String(), body: Type.Union([Type.String(), Type.Null()]), draft: Type.Boolean(), prerelease: Type.Boolean(), published_at: Type.Union([Type.String(), Type.Null()]) });
const comparisonSchema = Type.Object({ commits: Type.Array(Type.Object({ sha: Type.String({ pattern: "^[a-f0-9]{40}$" }) })), status: Type.Union([Type.Literal("ahead"), Type.Literal("behind"), Type.Literal("identical"), Type.Literal("diverged")]) });
const revisionSchema = Type.String({ pattern: "^[a-f0-9]{40}$" });

export async function fetchReleaseHistory(current: string, target: string, fetcher: HttpFetcher = fetch): Promise<{ releases: PublishedRelease[]; targetHasNotes: boolean; compareUrl: string }> {
  Value.Assert(revisionSchema, current);
  Value.Assert(revisionSchema, target);
  const base = `https://api.github.com/repos/${githubRepository}`;
  async function get<T extends TSchema>(path: string, schema: T): Promise<Static<T>> {
    const response = await fetcher(`${base}/${path}`, { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`Could not load release history (GitHub ${response.status})`);
    return Value.Parse(schema, await response.json());
  }
  const crossedRevisions = new Set<string>();
  for (let page = 1; ; page++) {
    const comparison = await get(`compare/${current}...${target}?per_page=100&page=${page}`, comparisonSchema);
    if (comparison.status !== "ahead" && comparison.status !== "identical") throw new Error("This update is not newer than your installed revision. Release notes cannot be shown as changes since your installation.");
    for (const commit of comparison.commits) crossedRevisions.add(commit.sha);
    if (comparison.commits.length < 100) break;
  }
  const releases: PublishedRelease[] = [];
  let targetHasNotes = false;
  for (let page = 1; ; page++) {
    const entries = await get(`releases?per_page=100&page=${page}`, Type.Array(githubReleaseSchema));
    for (const entry of entries) {
      if (entry.draft || entry.prerelease || !entry.tag_name.startsWith(releaseTagPrefix)) continue;
      const { record, notes } = parseReleaseBody(entry.body ?? "");
      if (entry.tag_name !== `${releaseTagPrefix}${record.id}`) throw new Error("Stable release tag does not match its publication record");
      if (!entry.published_at) throw new Error("Stable release is missing its publication date");
      if (record.revision === target) targetHasNotes = true;
      if (crossedRevisions.has(record.revision)) {
        releases.push({ ...record, notes, publishedAt: entry.published_at });
      }
    }
    if (entries.length < 100) break;
  }
  releases.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { releases, targetHasNotes, compareUrl: `https://github.com/${githubRepository}/compare/${current}...${target}` };
}
