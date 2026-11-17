import { Value } from "typebox/value";
import { Type, type TSchema } from "typebox";
import { githubRepository } from "../packages/shared/src/publishing.ts";
import { parseReleaseBody, releaseBody, releaseTagPrefix, type ReleaseRecord } from "../packages/update/src/server/release-history.ts";
import type { Run } from "./release-support.ts";

const githubReleaseSchema = Type.Object({ id: Type.Integer(), tag_name: Type.String(), target_commitish: Type.String(), body: Type.Union([Type.String(), Type.Null()]), draft: Type.Boolean() });
const refSchema = Type.Object({ object: Type.Object({ type: Type.String(), sha: Type.String() }) });
interface ReleaseMutation { tag_name?: string; target_commitish?: string; name?: string; body: string; draft: boolean; prerelease?: boolean; }
export interface ReleaseNotes { id: string; path: string; notes: string; sourceRevision: string; }

export async function readReleaseNotes(run: Run, revision: string, path: string): Promise<ReleaseNotes> {
  const match = path.match(/^release_notes\/(\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
  if (!match) throw new Error("Use --notes release_notes/YYYY-MM-DD-short-description.md");
  const notes = (await run(["git", "show", `${revision}:${path}`])).stdout.trim();
  if (!notes) throw new Error("Release notes must not be empty");
  return { id: match[1]!, path, notes, sourceRevision: revision };
}

async function api<T extends TSchema>(run: Run, path: string, schema: T, method = "GET", body?: ReleaseMutation) {
  const result = await run(["gh", "api", `repos/${githubRepository}/${path}`, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], { input: body === undefined ? undefined : JSON.stringify(body), allowFailure: true });
  if (result.code !== 0) {
    if (method === "GET" && /HTTP 404\b/.test(result.stderr)) return undefined;
    throw new Error(`GitHub release request failed: ${result.stderr}`);
  }
  return Value.Parse(schema, JSON.parse(result.stdout));
}

async function findRelease(run: Run, tag: string) {
  for (let page = 1; ; page++) {
    const entries = await api(run, `releases?per_page=100&page=${page}`, Type.Array(githubReleaseSchema));
    if (!entries) throw new Error("GitHub release history is unavailable");
    const release = entries.find(entry => entry.tag_name === tag);
    if (release) return release;
    if (entries.length < 100) return undefined;
  }
}

export async function prepareReleaseNotes(run: Run, notes: ReleaseNotes, revision: string): Promise<void> {
  const tag = `${releaseTagPrefix}${notes.id}`;
  const ref = await api(run, `git/ref/tags/${tag}`, refSchema);
  if (ref !== undefined && (ref.object.type !== "commit" || ref.object.sha !== revision)) throw new Error(`Tag ${tag} already identifies another revision`);
  const release = await findRelease(run, tag);
  if (release !== undefined) {
    if (release.target_commitish !== revision) throw new Error(`Release notes ID ${notes.id} is already associated with another revision`);
    const parsed = parseReleaseBody(release.body ?? "");
    if (parsed.record.revision !== revision || (parsed.record.notesRevision ?? parsed.record.revision) !== notes.sourceRevision || parsed.record.notesPath !== notes.path || parsed.notes !== notes.notes) throw new Error("Published or reserved release notes do not match this release");
    if (!release.draft && ref === undefined) throw new Error("Published release tag is missing");
    return;
  }
  await api(run, "releases", githubReleaseSchema, "POST", { tag_name: tag, target_commitish: revision, name: notes.id, body: releaseBody({ id: notes.id, notesPath: notes.path, revision, notesRevision: notes.sourceRevision, digest: `sha256:${"0".repeat(64)}` }, notes.notes), draft: true, prerelease: false });
}

export async function publishReleaseNotes(run: Run, notes: ReleaseNotes, revision: string, digest: string): Promise<void> {
  const tag = `${releaseTagPrefix}${notes.id}`;
  const release = Value.Parse(githubReleaseSchema, await findRelease(run, tag));
  const parsed = parseReleaseBody(release.body ?? "");
  if (release.tag_name !== tag || release.target_commitish !== revision || parsed.record.revision !== revision || parsed.notes !== notes.notes || (parsed.record.notesRevision ?? parsed.record.revision) !== notes.sourceRevision || parsed.record.notesPath !== notes.path) throw new Error("Reserved release notes changed during publication");
  const record: ReleaseRecord = { id: notes.id, revision, notesRevision: notes.sourceRevision, digest, notesPath: notes.path };
  if (!release.draft) {
    if (parsed.record.digest !== digest) throw new Error("Published release has a different image digest");
    const ref = Value.Parse(Type.Object({ object: Type.Object({ type: Type.String(), sha: Type.String() }) }), await api(run, `git/ref/tags/${tag}`, refSchema));
    if (ref.object.type !== "commit" || ref.object.sha !== revision) throw new Error("Published release tag has a different revision");
    return;
  }
  const published = await api(run, `releases/${release.id}`, githubReleaseSchema, "PATCH", { body: releaseBody(record, notes.notes), draft: false });
  if (!published) throw new Error("GitHub release publication is missing");
  if (published.draft) throw new Error("GitHub release is still a draft");
  const ref = await api(run, `git/ref/tags/${tag}`, refSchema);
  if (!ref || ref.object.type !== "commit" || ref.object.sha !== revision) throw new Error("Published release tag has a different revision");
}
