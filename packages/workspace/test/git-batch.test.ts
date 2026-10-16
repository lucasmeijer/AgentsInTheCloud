import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeRepositoryBatch, repositoryBatchRunner, type RepositoryRequest } from "../src/git-batch.ts";
import { safeGitArguments } from "../src/git-repository.ts";
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
async function run(root: string, requests: RepositoryRequest[], runner = repositoryBatchRunner) {
  const wire = requests.map(request => request.kind === "git" ? { ...request, args: safeGitArguments(request.args) }
    : request.kind === "index-tree" ? { ...request, args: safeGitArguments(["rev-parse", "--git-path", "index"]), writeArgs: safeGitArguments(["write-tree"]) } : request);
  const child = Bun.spawn(["bun", "--no-env-file", "--config=/dev/null", "--eval", runner], { cwd: root, env: { ...Bun.env, TMPDIR: join(root, "temporary") }, stdin: Buffer.from(JSON.stringify(wire)), stdout: "pipe", stderr: "pipe" });
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
  // Neither project preload settings nor .env should affect the trusted runner.
  await writeFile(join(root, "bunfig.toml"), 'preload = ["./attack.ts"]\n');
  await writeFile(join(root, "attack.ts"), 'throw new Error("repository preload ran");');
  await writeFile(join(root, ".env"), 'NODE_OPTIONS=--require=./attack.ts\n');
  const results = await run(root, [
    { kind: "git", args: ["cat-file", "blob", hash] },
    { kind: "git", args: ["rev-parse", "--verify", "refs/heads/missing"] },
    { kind: "working-file", path },
    { kind: "working-file", path: "link" },
    { kind: "working-file", path: "missing" },
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
  const requests: RepositoryRequest[] = Array.from({ length: 1000 }, () => ({ kind: "working-file", path: "x".repeat(150) }));
  const results = await run(root, [{ kind: "index-tree" }, ...requests]);
  expect(results[0]!.exitCode).toBe(0);
  expect(results[0]!.stdout.toString().trim()).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  expect(results.slice(1).every(result => result.exitCode === 44)).toBe(true);
  expect(await Bun.file(join(root, ".git/index")).exists()).toBe(false);
});

test("batch runner makes read errors visible and rejects escaping paths", async () => {
  const { root } = await fixture();
  await expect(run(root, [{ kind: "working-file", path: "../outside" }, { kind: "index-tree" }])).rejects.toThrow("File path escapes repository");
  expect(await readdir(join(root, "temporary"))).toEqual([]);
});

test("sparse multi-GiB reads and write-original checks never materialise the file", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(root, "firmware"), "");
  await truncate(join(root, "firmware"), 12 * 1024 ** 3);
  const [result] = await run(root, [{ kind: "working-file", path: "firmware" }]);
  expect(result!.exitCode).toBe(46);
  expect(result!.stdout.toString()).toBe(`100644\n${12 * 1024 ** 3}`);
  expect(await repo.writeWorkingFile("firmware", { hash: "stale", mode: "100644" }, "edit")).toBe("changed");
});

test("batch content retention is bounded even for many individually allowed files", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "allowed"), "");
  await truncate(join(root, "allowed"), 8 * 1024 ** 2);
  const results = await run(root, Array.from({ length: 8 }, () => ({ kind: "working-file", path: "allowed" })));
  expect(results.some(result => result.exitCode === 46)).toBe(true);
  expect(results.reduce((sum, result) => sum + result.stdout.length, 0)).toBeLessThan(32 * 1024 ** 2);
});

test("hard descriptor bound survives growth after stat and refuses symlink replacement", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "growing"), "tiny");
  const growing = repositoryBatchRunner.replace("const buffer = Buffer.alloc(info.size + 1);", "await require('node:fs/promises').truncate('growing', 8 * 1024 ** 3); const buffer = Buffer.alloc(info.size + 1);");
  const [result] = await run(root, [{ kind: "working-file", path: "growing" }], growing);
  expect(result!.exitCode).toBe(46);
  expect(result!.stdout.length).toBeLessThan(64);
  await writeFile(join(root, "victim"), "tiny");
  const swapped = repositoryBatchRunner.replace("const handle = await open(path,", "await rm(path); await require('node:fs/promises').symlink('growing', path); const handle = await open(path,");
  expect((await run(root, [{ kind: "working-file", path: "victim" }], swapped))[0]!.exitCode).toBe(44);
});

test("Git content output has a hard bound, independently of metadata probes", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(root, "blob"), "x".repeat(64));
  await repo.gitResult(["add", "blob"]);
  const runner = repositoryBatchRunner.replace("const maxFileBytes = 16 * 1024 * 1024;", "const maxFileBytes = 32;");
  const results = await run(root, [{ kind: "git", args: ["show", ":blob"] }, { kind: "working-file", path: "missing" }], runner);
  expect(results[0]!.exitCode).toBe(47);
  expect(results[0]!.stderr).toContain("content budget");
  expect(results[0]!.stdout.length).toBe(0);
  expect(results[1]!.exitCode).toBe(44);
});

test("aggregate Git budget exhaustion is an individual bounded failure, not a crashed batch", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(root, "blob"), "small content");
  await repo.gitResult(["add", "blob"]);
  const runner = repositoryBatchRunner.replace("const maxBatchBytes = 32 * 1024 * 1024;", "const maxBatchBytes = 64;");
  const results = await run(root, Array.from({ length: 16 }, () => ({ kind: "git", args: ["show", ":blob"] })), runner);
  expect(results.some(result => result.exitCode === 47 && result.stderr.includes("content budget"))).toBe(true);
  expect(results.filter(result => result.exitCode === 0).reduce((sum, result) => sum + result.stdout.length, 0)).toBeLessThanOrEqual(64);
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
