import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isNotFoundError } from "@agents-in-the-cloud/core";
import { decodeWorkingFileWrite, decodeRepositoryBatch, repositoryBatchRunner } from "../../src/git-batch.ts";
import { createWorkspaceRepository, safeGitArguments, type Repository } from "../../src/git-repository.ts";

/** Explicitly trusted host repositories for local tools and domain fixtures; application workspaces never use this adapter. */
export function localRepository(root: string): Repository {
  const bounded = createWorkspaceRepository("fixture", "", async (_id, command, options) => {
    const child = Bun.spawn(command, { cwd: root, stdin: options.stdin === undefined ? "ignore" : Buffer.from(String(options.stdin)), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    return { stdout: Buffer.from(stdout), stderr, exitCode };
  });
  const repository: Repository = {
    async gitResult(args) {
      try { await stat(root); }
      catch (error) {
        if (!isNotFoundError(error)) throw error;
        return { exitCode: 128, stderr: "Repository directory not found", stdout: Buffer.alloc(0) };
      }
      const process = Bun.spawn(safeGitArguments(args), { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited]);
      return { stdout: Buffer.from(stdout), stderr, exitCode };
    },
    workingFile: bounded.workingFile,
    async writeWorkingFile(path, expected, contents) {
      const child = Bun.spawn(["bun", "--no-env-file", "--config=/dev/null", "--eval", repositoryBatchRunner], { cwd: root, stdin: Buffer.from(JSON.stringify([{ kind: "write-working-file", path, expected, contents }])), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(stderr);
      return decodeWorkingFileWrite(decodeRepositoryBatch(Buffer.from(stdout), 1)[0]!);
    },
    async captureIndexTree() {
      const directory = await mkdtemp(join(tmpdir(), "changes-index-"));
      const index = join(directory, "index");
      try {
        const result = await repository.gitResult(["rev-parse", "--git-path", "index"]);
        if (result.exitCode !== 0) throw new Error(result.stderr);
        try { await copyFile(resolve(root, result.stdout.toString().trim()), index); }
        catch (error) { if (!isNotFoundError(error)) throw error; }
        const process = Bun.spawn(safeGitArguments(["write-tree"]), { cwd: root, env: { ...Bun.env, GIT_INDEX_FILE: index }, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited]);
        if (exitCode !== 0) throw new Error(stderr.trim());
        return Buffer.from(stdout);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
  return repository;
}
