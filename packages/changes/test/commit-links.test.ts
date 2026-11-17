import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@agents-in-the-cloud/workspace/git";
import { parseCommitLinkSpec } from "@agents-in-the-cloud/shared";
import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { captureChanges, stagedChanges, workingTree } from "../src/server/snapshot.ts";
import { commitLinkLabel, openCommitLink } from "../src/server/commit-links.ts";
import { refreshChanges } from "../src/server/refresh.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function repository(commits: number) {
  const root = await mkdtemp(join(tmpdir(), "changes-links-"));
  roots.push(root);
  const repo = localRepository(root);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Changes Test"]);
  await git(repo, ["config", "user.email", "changes@example.com"]);
  const ids: string[] = [];
  for (let index = 0; index < commits; index++) {
    await writeFile(join(root, "file.txt"), `${index}\n`);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", `Commit ${index}`]);
    ids.push((await git(repo, ["rev-parse", "HEAD"])).toString().trim());
  }
  return { root, repo, ids };
}
const link = (spec: string) => parseCommitLinkSpec(spec)!;

test("a link to an old commit loads history down to it and compares it with its parent", async () => {
  const { repo, ids } = await repository(80);
  const opened = await openCommitLink(repo, await captureChanges(repo), link(ids[3]!.slice(0, 9)));
  expect(opened.notice).toBeUndefined();
  expect(opened.endpoints).toEqual({ target: ids[3]! });
  expect(opened.base).toBe(ids[2]!);
  expect(opened.history.commits.some(commit => commit.id === ids[3])).toBe(true);
  expect(opened.files.get("file.txt")!.newContents).toBe("3\n");
});

test("ranges follow git's A..B, accept A^, and order themselves by ancestry", async () => {
  const { repo, ids } = await repository(4);
  const previous = await captureChanges(repo);
  const range = await openCommitLink(repo, previous, link(`${ids[1]}^..${ids[2]}`));
  expect(range.endpoints).toEqual({ base: ids[0]!, target: ids[2]! });
  const reversed = await openCommitLink(repo, previous, link(`${ids[2]}..${ids[0]}`));
  expect(reversed.endpoints).toEqual({ base: ids[0]!, target: ids[2]! });
});

test("live snapshots compare against HEAD; staged means HEAD when nothing is staged", async () => {
  const { root, repo, ids } = await repository(2);
  await writeFile(join(root, "file.txt"), "working\n");
  const previous = await captureChanges(repo);
  expect((await openCommitLink(repo, previous, link("working"))).endpoints).toEqual({ target: workingTree, base: ids[1]! });
  expect((await openCommitLink(repo, previous, link("staged..working"))).endpoints).toEqual({ target: workingTree, base: ids[1]! });
  expect((await openCommitLink(repo, previous, link("staged"))).notice).toBe("Nothing is staged right now.");
  await git(repo, ["add", "."]);
  const staged = await openCommitLink(repo, previous, link(`${ids[0]}..staged`));
  expect(staged.endpoints).toEqual({ target: stagedChanges, base: ids[0]! });
  expect(staged.files.get("file.txt")!.newContents).toBe("working\n");
});

test("commits that can't be shown keep the current comparison and explain why", async () => {
  const { repo, ids } = await repository(2);
  await git(repo, ["reset", "--hard", ids[0]!]);
  const previous = await captureChanges(repo);
  const rewritten = await openCommitLink(repo, previous, link(ids[1]!));
  expect(rewritten.notice).toBe(`Commit ${ids[1]!.slice(0, 7)} isn’t on any local branch.`);
  expect(rewritten.endpoints).toEqual(previous.endpoints);
  expect((await openCommitLink(repo, previous, link("deadbeefdeadbeef"))).notice).toBe("Commit deadbee isn’t in this repository.");
});

test("labels show a commit's subject or a range's size, and nothing for missing commits", async () => {
  const { repo, ids } = await repository(4);
  expect(await commitLinkLabel(repo, link(ids[2]!))).toBe("Commit 2");
  expect(await commitLinkLabel(repo, link(`${ids[0]}..${ids[3]}`))).toBe("· 3 commits");
  expect(await commitLinkLabel(repo, link(`${ids[3]}..${ids[2]}`))).toBe("· 1 commit");
  expect(await commitLinkLabel(repo, link("deadbeefdeadbeef"))).toBeUndefined();
});

test("a dismissed notice stays dismissed on refreshes that keep the comparison", async () => {
  const { repo, ids } = await repository(2);
  await git(repo, ["reset", "--hard", ids[0]!]);
  const opened = await openCommitLink(repo, await captureChanges(repo), link(ids[1]!));
  const kept = await refreshChanges(repo, opened);
  expect(kept.notice).toBe(opened.notice!);
  kept.notice = undefined;
  expect((await refreshChanges(repo, kept)).notice).toBeUndefined();
});
