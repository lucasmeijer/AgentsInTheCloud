import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectCommitChangesFile, collectChangesComparison, collectChangesFile, collectChangesIndex, collectChangesStats, collectUnchangedPaths, readUnchangedContents, readUnchangedFile, type ChangesFile } from "../src/server/diff.ts";
import { command, createChangesRepository } from "./support/repository.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await createChangesRepository();
  roots.push(root);
  return root;
}

async function changesFiles(root: string): Promise<ChangesFile[]> {
  const index = await collectChangesIndex(localRepository(root));
  if (index.phase !== "ready") throw new Error("expected ready changes");
  const files = await Promise.all(index.files.map((file) => collectChangesFile(localRepository(root), file.path)));
  return files.filter((file): file is ChangesFile => file !== undefined);
}

describe("Changes collection", () => {
  test("reports a non-repository without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-changes-not-git-"));
    roots.push(root);
    expect((await collectChangesIndex(localRepository(root))).phase).toBe("not-git");
  });

  test("lists tracked and untracked changes without collecting file details", async () => {
    const root = await repository();
    await writeFile(join(root, "changed.ts"), "const after = true;\nconst added = 1;\n");
    await writeFile(join(root, "untracked.ts"), "export const newFile = true;\n");
    await writeFile(join(root, "ignored.txt"), "not reviewed\n");

    const index = await collectChangesIndex(localRepository(root));
    expect(index).toEqual({ phase: "ready", files: [
      { path: "changed.ts", change: "modified" },
      { path: "untracked.ts", change: "added", untracked: true },
    ] });
    expect(await collectChangesStats(localRepository(root), index)).toEqual([
      { path: "changed.ts", change: "modified", additions: 2, deletions: 1 },
      { path: "untracked.ts", change: "added", untracked: true, additions: 1, deletions: 0 },
    ]);

    const files = await changesFiles(root);
    expect(files.map((file) => file.path)).toEqual(["changed.ts", "untracked.ts"]);
    expect(files[1]!.kind).toBe("text");
  });

  test("shows an untracked nested repository as one entry", async () => {
    const root = await repository();
    await mkdir(join(root, "nested"));
    await command(join(root, "nested"), "git", "init", "-q");
    await writeFile(join(root, "nested", "inner.ts"), "export const inner = true;\n");

    const nested: ChangesFile = { path: "nested/", change: "added", kind: "mode", detail: "Nested Git repository" };
    expect(await changesFiles(root)).toEqual([nested]);
    const comparison = await collectChangesComparison(localRepository(root), "HEAD");
    expect(comparison.stats).toEqual([{ path: "nested/", change: "added", untracked: true, additions: 0, deletions: 0 }]);
    expect(comparison.files.get("nested/")).toMatchObject(nested);
  });

  test("counts untracked text lines with or without a trailing newline", async () => {
    const root = await repository();
    for (const [path, text] of Object.entries({ "empty-new.txt": "", "newline.txt": "héllo\nworld\n", "no-newline.txt": "héllo\nworld" })) {
      await writeFile(join(root, path), text);
    }
    const stats = await collectChangesStats(localRepository(root), await collectChangesIndex(localRepository(root)));
    expect(stats.map(({ path, additions }) => ({ path, additions }))).toEqual([
      { path: "empty-new.txt", additions: 0 },
      { path: "newline.txt", additions: 2 },
      { path: "no-newline.txt", additions: 2 },
    ]);
  });

  test("collects stats before the repository has its first commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-changes-unborn-"));
    roots.push(root);
    await command(root, "git", "init");
    await writeFile(join(root, "first.ts"), "export const first = true;\n");
    await command(root, "git", "add", "first.ts");
    const index = await collectChangesIndex(localRepository(root));
    expect(await collectChangesStats(localRepository(root), index)).toEqual([{ path: "first.ts", change: "added", additions: 1, deletions: 0 }]);
  });

  test("classifies whole-file additions and removals", async () => {
    const root = await repository();
    await writeFile(join(root, "added.ts"), "export const added = true;\n");
    await rm(join(root, "changed.ts"));

    const index = await collectChangesIndex(localRepository(root));
    if (index.phase !== "ready") throw new Error("expected ready changes");
    expect(index.files.map(({ path, change }) => ({ path, change }))).toEqual([
      { path: "added.ts", change: "added" },
      { path: "changed.ts", change: "removed" },
    ]);
  });

  test("keeps empty files and rename metadata", async () => {
    const root = await repository();
    await command(root, "git", "mv", "empty.txt", "renamed.txt");
    const index = await collectChangesIndex(localRepository(root));
    expect(await collectChangesStats(localRepository(root), index)).toEqual([{ path: "renamed.txt", previousPath: "empty.txt", change: "modified", additions: 0, deletions: 0 }]);
    const files = await changesFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("renamed.txt");
    expect(files[0]!.previousPath).toBe("empty.txt");
    expect(files[0]!.detail).toBe("File renamed");
  });

  test("omits a staged addition deleted again before review", async () => {
    const root = await repository();
    const transient = join(root, "transient.ts");
    await writeFile(transient, "temporary\n");
    await command(root, "git", "add", "transient.ts");
    await rm(transient);
    expect(await changesFiles(root)).toEqual([]);
  });

  test("collects binary sizes for modified, removed, renamed, and new files", async () => {
    const root = await repository();
    for (const path of ["modified.bin", "removed.bin", "original.bin"]) {
      await writeFile(join(root, path), Buffer.alloc(1024));
    }
    await command(root, "git", "add", ".");
    await command(root, "git", "commit", "-m", "Binary fixtures");
    await writeFile(join(root, "modified.bin"), Buffer.alloc(2048));
    await rm(join(root, "removed.bin"));
    await command(root, "git", "mv", "original.bin", "renamed.bin");
    await writeFile(join(root, "new.bin"), Buffer.alloc(32));
    await writeFile(join(root, "staged.bin"), Buffer.alloc(64));
    await command(root, "git", "add", "staged.bin");
    const stats = await collectChangesStats(localRepository(root), await collectChangesIndex(localRepository(root)));
    expect(Object.fromEntries(stats.map((file) => [file.path, file.binarySizes]))).toEqual({
      "modified.bin": { before: 1024, after: 2048 },
      "removed.bin": { before: 1024, after: undefined },
      "renamed.bin": { before: 1024, after: 1024 },
      "new.bin": { after: 32 },
      "staged.bin": { before: undefined, after: 64 },
    });
    expect(stats.every((file) => file.additions === 0 && file.deletions === 0)).toBe(true);
  });

  test("classifies binary changes without rendering them as text", async () => {
    const root = await repository();
    await writeFile(join(root, "asset.bin"), new Uint8Array([0, 1, 2, 3]));
    expect((await changesFiles(root))[0]!.kind).toBe("binary");
  });


  test("multi-GiB sparse untracked files are listed, sized and reviewed without full reads", async () => {
    const root = await repository();
    await writeFile(join(root, "firmware.bin"), "");
    const size = 12 * 1024 ** 3;
    await truncate(join(root, "firmware.bin"), size);
    const repo = localRepository(root);
    const index = await collectChangesIndex(repo);
    expect(index).toMatchObject({ phase: "ready", files: [{ path: "firmware.bin", untracked: true }] });
    expect(await collectChangesStats(repo, index)).toMatchObject([{ binarySizes: { after: size }, additions: 0 }]);
    expect(await collectChangesFile(repo, "firmware.bin")).toMatchObject({ kind: "large", change: "added" });
    const comparison = await collectChangesComparison(repo, "HEAD");
    expect(comparison.files.get("firmware.bin")?.kind).toBe("large");
    expect(comparison.stats[0]?.binarySizes?.after).toBe(size);
    expect(await readUnchangedFile(repo, undefined, "firmware.bin")).toEqual({ kind: "large" });
  });

  test("oversized tracked and committed blobs use size probes, not blob content reads", async () => {
    const root = await repository();
    await writeFile(join(root, "big.txt"), "");
    await truncate(join(root, "big.txt"), 1_000_001);
    await command(root, "git", "add", "big.txt");
    await command(root, "git", "commit", "-qm", "large blob");
    const repo = localRepository(root);
    const original = repo.gitResult;
    const contentReads: string[][] = [];
    repo.gitResult = async args => {
      if (args[0] === "cat-file" && args[1] === "blob") contentReads.push(args);
      return original(args);
    };
    expect(await collectCommitChangesFile(repo, "HEAD", "big.txt")).toMatchObject({ kind: "large" });
    expect(await readUnchangedFile(repo, "HEAD", "big.txt")).toEqual({ kind: "large" });
    await writeFile(join(root, "big.txt"), "small\n");
    expect(await collectChangesFile(repo, "big.txt")).toMatchObject({ kind: "large", change: "modified" });
    expect((await collectChangesComparison(repo, "HEAD")).files.get("big.txt")?.kind).toBe("large");
    expect(contentReads).toEqual([]);
  });

  test("comparison snapshots bound total retained images across many small files", async () => {
    const root = await repository();
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(root, `image-${index}.png`), Buffer.alloc(500_000))));
    const comparison = await collectChangesComparison(localRepository(root), "HEAD");
    expect(comparison.files.size).toBe(40);
    expect(comparison.stats).toHaveLength(40);
    expect([...comparison.files.values()].some(file => file.kind === "large")).toBe(true);
    const bytes = [...comparison.files.values()].reduce((sum, file) => sum + (file.images?.after?.contents.length ?? 0), 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(comparison.stats.every(stat => stat.binarySizes?.after === 500_000)).toBe(true);
  });

  test("unchanged media defaults to 16 MiB and reports larger content without reading it", async () => {
    const root = await repository();
    const path = join(root, "media.mp4"), limit = 16 * 1024 * 1024;
    await writeFile(path, "");
    await truncate(path, limit);
    const repo = localRepository(root);
    const boundary = await readUnchangedContents(repo, undefined, "media.mp4");
    expect(boundary.contents.length).toBe(limit);
    expect(boundary.oversized).toBeUndefined();
    await truncate(path, limit + 1);
    expect(await readUnchangedContents(repo, undefined, "media.mp4")).toMatchObject({ contents: Buffer.alloc(0), size: limit + 1, mode: "100644", oversized: true });
    await command(root, "git", "add", "media.mp4");
    await command(root, "git", "commit", "-qm", "large media");
    expect(await readUnchangedContents(repo, "HEAD", "media.mp4")).toEqual({ contents: Buffer.alloc(0), size: limit + 1, oversized: true });
  });

  test("lists and reads unchanged files in the working tree and in commits", async () => {
    const root = await repository();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "kept.ts"), "export const kept = 1;\n");
    await writeFile(join(root, "gone.txt"), "soon deleted\n");
    await command(root, "git", "add", ".");
    await command(root, "git", "commit", "-qm", "more");
    await writeFile(join(root, "changed.ts"), "const after = true;\n");
    await rm(join(root, "gone.txt"));
    await writeFile(join(root, "ignored.txt"), "not listed\n");
    const repo = localRepository(root);
    const working = await collectChangesComparison(repo, "HEAD");
    expect(await collectUnchangedPaths(repo, undefined, new Set(working.files.keys()))).toEqual([".gitignore", "empty.txt", "src/kept.ts"]);
    expect(await readUnchangedFile(repo, undefined, "src/kept.ts")).toEqual({ kind: "text", text: "export const kept = 1;\n", mode: "100644" });
    const commit = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    expect(await collectUnchangedPaths(repo, commit, new Set(["changed.ts"]))).toEqual([".gitignore", "empty.txt", "gone.txt", "src/kept.ts"]);
    expect(await readUnchangedFile(repo, commit, "gone.txt")).toEqual({ kind: "text", text: "soon deleted\n" });
  });
});
