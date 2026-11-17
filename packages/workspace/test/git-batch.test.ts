import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeRepositoryBatch, repositoryBatchRunner, type RepositoryRequest } from "../src/git-batch.ts";
import { blobArguments, decodeBlob, decodeWorkingFile, safeGitArguments } from "../src/git-repository.ts";
import { localRepository } from "./support/local-repository.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repository-batch-test-"));
  directories.push(root);
  await mkdir(join(root, "temporary"));
  const repo = localRepository(root);
  await repo.gitResult(["init", "-b", "main"]);
  return { root, repo };
}
async function run(root: string, requests: RepositoryRequest[]) {
  const wire = requests.map(request => request.kind === "git" ? { ...request, args: safeGitArguments(request.args) }
    : request.kind === "index-tree" ? { ...request, args: safeGitArguments(["rev-parse", "--git-path", "index"]), writeArgs: safeGitArguments(["write-tree"]) }
    : request.kind === "blob" ? { ...request, ...blobArguments } : request);
  const child = Bun.spawn(["bun", "--no-env-file", "--config=/dev/null", "--eval", repositoryBatchRunner], { cwd: root, env: { ...Bun.env, TMPDIR: join(root, "temporary") }, stdin: Buffer.from(JSON.stringify(wire)), stdout: "pipe", stderr: "pipe" });
  const [output, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr);
  return decodeRepositoryBatch(Buffer.from(output), requests.length);
}

test("batch preserves ordered binary results, tricky filenames, symlink text, modes, and individual Git failures", async () => {
  const { root, repo } = await fixture();
  const path = "-odd\n\t'$(touch injected).bin";
  const bytes = Buffer.from([0, 255, 10, 0, 13, 128]);
  await writeFile(join(root, path), bytes);
  await chmod(join(root, path), 0o755);
  await symlink(path, join(root, "link"));
  await repo.gitResult(["add", "--", path, "link"]);
  const hash = (await repo.gitResult(["rev-parse", `:${path}`])).stdout.toString().trim();
  await writeFile(join(root, "bunfig.toml"), 'preload = ["./attack.ts"]\n');
  await writeFile(join(root, "attack.ts"), 'throw new Error("repository preload ran");');
  await writeFile(join(root, ".env"), 'NODE_OPTIONS=--require=./attack.ts\n');
  const results = await run(root, [
    { kind: "git", args: ["cat-file", "blob", hash] },
    { kind: "git", args: ["rev-parse", "--verify", "refs/heads/missing"] },
    { kind: "working-file", path, maxBytes: 1024 },
    { kind: "working-file", path: "link", maxBytes: 1024 },
    { kind: "working-file", path: "missing", maxBytes: 1024 },
    { kind: "index-tree" },
  ]);
  expect(results[0]!.stdout).toEqual(bytes);
  expect(results[1]!.exitCode).not.toBe(0);
  expect(results[1]!.stderr).toContain("fatal");
  expect(results[2]!.stdout).toEqual(Buffer.concat([Buffer.from("100755\n"), bytes]));
  expect(results[3]!.stdout.toString()).toBe(`120000\n${path}`);
  expect(results[4]!.exitCode).toBe(44);
  expect(results[5]!.exitCode).toBe(0);
  expect(await Bun.file(join(root, "injected")).exists()).toBe(false);
});

test("files and blobs larger than their bound report size without being read", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(root, "small"), "small\n");
  await writeFile(join(root, "huge"), "");
  await truncate(join(root, "huge"), 5 * 1024 ** 3);
  await writeFile(join(root, "committed"), Buffer.alloc(2048, 1));
  await repo.gitResult(["add", "small", "committed"]);
  await repo.gitResult(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "files"]);
  const results = await run(root, [
    { kind: "working-file", path: "huge", maxBytes: 1024 },
    { kind: "working-file", path: "small", maxBytes: 1024 },
    { kind: "working-file", path: "small", maxBytes: 0 },
    { kind: "blob", object: "HEAD:committed", maxBytes: 1024 },
    { kind: "blob", object: "HEAD:committed", maxBytes: 4096 },
    { kind: "blob", object: "HEAD:missing", maxBytes: 1024 },
    { kind: "blob", object: "HEAD", maxBytes: 1024 },
  ]);
  expect(decodeWorkingFile(results[0]!)).toEqual({ mode: "100644", size: 5 * 1024 ** 3 });
  expect(decodeWorkingFile(results[1]!)).toEqual({ mode: "100644", size: 6, contents: Buffer.from("small\n") });
  expect(decodeWorkingFile(results[2]!)).toEqual({ mode: "100644", size: 6 });
  expect(decodeBlob(results[3]!)).toEqual({ size: 2048 });
  expect(decodeBlob(results[4]!)).toEqual({ size: 2048, contents: Buffer.alloc(2048, 1) });
  expect(decodeBlob(results[5]!)).toBeUndefined();
  expect(decodeBlob(results[6]!)).toBeUndefined();
});

test("temporary index capture preserves the real index on success and write-tree failure", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(root, "file"), "staged\n");
  await repo.gitResult(["add", "file"]);
  const index = join(root, ".git/index");
  const before = await readFile(index);
  await writeFile(join(root, "file"), "working\n");
  expect((await run(root, [{ kind: "index-tree" }, { kind: "git", args: ["status", "--porcelain=v1", "-z"] }]))[0]!.exitCode).toBe(0);
  expect(await readFile(index)).toEqual(before);
  const hash = (await repo.gitResult(["rev-parse", ":file"])).stdout.toString().trim();
  const update = Bun.spawn(safeGitArguments(["update-index", "--index-info"]), { cwd: root, stdin: Buffer.from(`0 ${"0".repeat(40)}\tfile\n100644 ${hash} 1\tfile\n100644 ${hash} 2\tfile\n`), stdout: "pipe", stderr: "pipe" });
  expect(await update.exited).toBe(0);
  const conflicted = await readFile(index);
  const [failed, successful] = await run(root, [{ kind: "index-tree" }, { kind: "git", args: ["rev-parse", "--git-dir"] }]);
  expect(failed!.exitCode).not.toBe(0);
  expect(failed!.stderr).toContain("unmerged");
  expect(successful!.exitCode).toBe(0);
  expect(await readFile(index)).toEqual(conflicted);
  expect(await readdir(join(root, "temporary"))).toEqual([]);
});

test("unborn index capture and requests larger than argv limits use stdin", async () => {
  const { root } = await fixture();
  const requests: RepositoryRequest[] = Array.from({ length: 1000 }, () => ({ kind: "working-file", path: "x".repeat(150), maxBytes: 1024 }));
  const results = await run(root, [{ kind: "index-tree" }, ...requests]);
  expect(results[0]!.exitCode).toBe(0);
  expect(results[0]!.stdout.toString().trim()).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  expect(results.slice(1).every(result => result.exitCode === 44)).toBe(true);
  expect(await Bun.file(join(root, ".git/index")).exists()).toBe(false);
});

test("batch runner makes read errors visible and rejects escaping paths", async () => {
  const { root } = await fixture();
  await expect(run(root, [{ kind: "working-file", path: "../outside", maxBytes: 1024 }, { kind: "index-tree" }])).rejects.toThrow("File path escapes repository");
  expect(await readdir(join(root, "temporary"))).toEqual([]);
});

test("framing rejects incomplete headers, truncated contents, wrong counts and trailing bytes", () => {
  expect(() => decodeRepositoryBatch(Buffer.alloc(11), 1)).toThrow("header");
  const header = Buffer.alloc(12);
  header.writeUInt32BE(100, 4);
  expect(() => decodeRepositoryBatch(header, 1)).toThrow("payload");
  expect(() => decodeRepositoryBatch(Buffer.alloc(12), 2)).toThrow("header");
  expect(() => decodeRepositoryBatch(Buffer.alloc(13), 1)).toThrow("Unexpected");
  expect(decodeRepositoryBatch(Buffer.alloc(0), 0)).toEqual([]);
});
