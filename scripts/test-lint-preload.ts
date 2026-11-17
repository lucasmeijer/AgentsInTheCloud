// Preloaded by every `bun test` run (see bunfig.toml) so test subsets also lint the repo.
// Parallel runs load this once per test file; a lock named after the coordinating
// process lets exactly one file lint while the tests run, and fail the run on errors.
import { afterAll } from "bun:test";
import { mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const lockDir = join(tmpdir(), "agents-in-the-cloud-test-lint");
const staleLockMs = 10 * 60_000;
const runId = process.env.BUN_TEST_WORKER_ID ? process.ppid : process.pid;

function claimLint(): boolean {
  mkdirSync(lockDir, { recursive: true });
  const now = Date.now();
  for (const name of readdirSync(lockDir)) {
    const path = join(lockDir, name);
    if (now - statSync(path).mtimeMs > staleLockMs) rmSync(path, { force: true });
  }
  try {
    openSync(join(lockDir, String(runId)), "wx");
    return true;
  } catch (error) {
    if (Error.isError(error) && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

if (claimLint()) {
  const lint = Bun.spawn([join(repoRoot, "node_modules/.bin/oxlint"), "."], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  afterAll(async () => {
    const [code, stdout, stderr] = await Promise.all([lint.exited, new Response(lint.stdout).text(), new Response(lint.stderr).text()]);
    if (code !== 0) throw new Error(`oxlint failed (run \`bun run lint\`):\n${stdout}${stderr}`);
  });
}
