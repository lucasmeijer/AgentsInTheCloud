import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRepository, git, readRepositoryBlob, type GitResult } from "../src/git-repository.ts";
import type { WorkspaceCommandOptions } from "../src/index.ts";
import { localRepository } from "./support/local-repository.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-git-"));
  directories.push(root);
  const setup = localRepository(root);
  await git(setup, ["init", "-b", "main"]);
  const calls: { id: string; command: string[]; options: WorkspaceCommandOptions }[] = [];
  // Internal transport seam: emulate workspace exec in a trusted fixture, never expose
  // host execution as an option on the production workspace/git interface.
  const repo = createWorkspaceRepository("fixture", "nested repo", async (id, command, options) => {
    calls.push({ id, command, options });
    if (options.stdin !== undefined) expect(options.stdin).toBeString();
    // SAFETY: the assertion above checks the runner supplies string stdin; direct Git supplies none.
    const input = options.stdin as string | undefined;
    const child = Bun.spawn(command, { cwd: root, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    return { stdout: Buffer.from(stdout), stderr, exitCode };
  });
  return { root, setup, repo, calls };
}

test("independent Git, file and index reads share one workspace exec; dependent waves stay separate", async () => {
  const { root, setup, repo, calls } = await fixture();
  await writeFile(join(root, "file"), "staged\n");
  await git(setup, ["add", "file"]);
  const originalIndex = await readFile(join(root, ".git/index"));
  const [status, file, tree] = await Promise.all([
    repo.gitResult(["status", "--porcelain=v1", "-z"]),
    repo.workingFile("file"),
    repo.captureIndexTree(),
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.id).toBe("fixture");
  expect(calls[0]!.options.workdir).toBe("/work/nested repo");
  expect(calls[0]!.options.user).toBe("agents-in-the-cloud");
  expect(calls[0]!.command.slice(0, 4)).toEqual(["bun", "--no-env-file", "--config=/dev/null", "--eval"]);
  expect(status.stdout.toString()).toBe("A  file\0");
  expect(file!.contents.toString()).toBe("staged\n");
  expect(await readFile(join(root, ".git/index"))).toEqual(originalIndex);
  const [contents, missing] = await Promise.all([
    repo.gitResult(["show", `${tree.toString().trim()}:file`]),
    repo.workingFile("missing"),
  ]);
  expect(calls).toHaveLength(2);
  expect(contents.stdout.toString()).toBe("staged\n");
  expect(missing).toBeUndefined();
  await repo.gitResult(["rev-parse", "--git-dir"]);
  expect(calls).toHaveLength(3);
  expect(calls[2]!.command[0]).toBe("bun");
  expect(calls[2]!.options.stdin).toBeString();
  expect(calls.every(call => call.options.user === "agents-in-the-cloud")).toBe(true);
});

test("Git failure remains an individual result; transport failure rejects every queued request", async () => {
  const { repo } = await fixture();
  const [failed, successful] = await Promise.all([
    repo.gitResult(["rev-parse", "--verify", "HEAD"]),
    repo.gitResult(["rev-parse", "--git-dir"]),
  ]);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stderr).toContain("fatal");
  expect(successful.exitCode).toBe(0);
  await expect(git(repo, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow("fatal");
  const unavailable = createWorkspaceRepository("fixture", "", async (): Promise<GitResult> => { throw new Error("workspace unavailable"); });
  const results = await Promise.allSettled([unavailable.gitResult(["status"]), unavailable.workingFile("file"), unavailable.captureIndexTree()]);
  expect(results.every(result => result.status === "rejected" && result.reason.message === "workspace unavailable")).toBe(true);
});

test("repository and working-file escape paths are rejected before execution", async () => {
  const execute = async () => { throw new Error("must not execute"); };
  expect(() => createWorkspaceRepository("fixture", "../outside", execute)).toThrow("escapes workspace");
  expect(() => createWorkspaceRepository("fixture", "/outside", execute)).toThrow("workspace-relative");
  const repo = createWorkspaceRepository("fixture", "", execute);
  await expect(repo.workingFile("../outside")).rejects.toThrow("escapes repository");
  await expect(repo.workingFile("/outside")).rejects.toThrow("repository-relative");
});

test("shared execution policy suppresses hostile hooks, fsmonitor, external diff and textconv", async () => {
  const { root, setup, repo, calls } = await fixture();
  const marker = join(root, "executed");
  const callback = join(root, "callback");
  await writeFile(callback, `#!/bin/sh\nprintf executed >> '${marker}'\n`);
  await chmod(callback, 0o755);
  await git(setup, ["config", "user.name", "Fixture"]);
  await git(setup, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "file"), "before\n");
  await writeFile(join(root, ".gitattributes"), "file diff=attack\n");
  await git(setup, ["add", "."]);
  await git(setup, ["commit", "-m", "initial"]);
  for (const [key, value] of [
    ["core.fsmonitor", callback], ["core.hooksPath", root],
    ["diff.external", callback], ["diff.attack.command", callback],
    ["diff.attack.textconv", callback], ["log.showSignature", "true"],
  ]) await git(setup, ["config", key!, value!]);
  await writeFile(join(root, "pre-commit"), await readFile(callback));
  await chmod(join(root, "pre-commit"), 0o755);
  await writeFile(join(root, "file"), "after\n");
  await Promise.all([
    git(repo, ["status", "--porcelain=v1", "-z"]),
    git(repo, ["diff", "HEAD", "--"]),
    git(repo, ["show", "HEAD", "--"]),
    git(repo, ["log", "--max-count=1"]),
  ]);
  await git(repo, ["add", "file"]);
  await git(repo, ["commit", "-m", "changed"]);
  expect(calls[0]!.command[0]).toBe("bun");
  expect(calls.at(-1)!.command[0]).toBe("bun");
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("working-file limits include the exact boundary and preserve oversized size and mode", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(root, "file"), "12345678");
  await chmod(join(root, "file"), 0o755);
  expect(await repo.workingFile("file", undefined, 8)).toEqual({ contents: Buffer.from("12345678"), size: 8, mode: "100755" });
  expect(await repo.workingFile("file", undefined, 7)).toEqual({ contents: Buffer.alloc(0), size: 8, mode: "100755", oversized: true });
  await writeFile(join(root, "empty"), "");
  expect(await repo.workingFile("empty", undefined, 0)).toMatchObject({ contents: Buffer.alloc(0), size: 0 });
});

test("blob probes pin moving refs and ignore replacement changes between size and content", async () => {
  const { root, setup, repo } = await fixture();
  await writeFile(join(root, "file"), "before\n");
  await git(setup, ["add", "file"]);
  const oldHash = (await git(setup, ["rev-parse", ":file"])).toString().trim();
  await writeFile(join(root, "file"), "x".repeat(64));
  const replacement = (await git(setup, ["hash-object", "-w", "file"])).toString().trim();
  const original = repo.gitResult;
  repo.gitResult = async args => {
    const result = await original(args);
    if (args[0] === "rev-parse") await git(setup, ["add", "file"]);
    if (args[0] === "cat-file" && args[1] === "-s") await git(setup, ["replace", oldHash, replacement]);
    return result;
  };
  expect(await readRepositoryBlob(repo, ":file", 7)).toEqual({ contents: Buffer.from("before\n"), size: 7 });
});

test("workspace-owned conditional writes serialize conflicting saves and retain executable permissions", async () => {
  const { root, repo, calls } = await fixture();
  await writeFile(join(root, "script"), "before\n");
  await chmod(join(root, "script"), 0o755);
  const hash = new Bun.CryptoHasher("sha256").update("before\n").digest("hex");
  const expected = { hash, mode: "100755" };
  const results = await Promise.all([repo.writeWorkingFile("script", expected, "first\n"), repo.writeWorkingFile("script", expected, "second\n")]);
  expect(results).toEqual(["saved", "changed"]);
  expect(await readFile(join(root, "script"), "utf8")).toBe("first\n");
  expect((await repo.workingFile("script"))!.mode).toBe("100755");
  expect(calls.every(call => call.options.user === "agents-in-the-cloud")).toBe(true);
  await expect(repo.writeWorkingFile(".git/config", expected, "unsafe")).rejects.toThrow("Invalid editable");
  await expect(repo.writeWorkingFile("../outside", expected, "unsafe")).rejects.toThrow("Invalid editable");
});
