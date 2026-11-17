import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHostInotifyLimit, inotifyMinimumScript } from "./host-inotify.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))); });

test.each([128, 1024, 8192, 65536])("raises %i to the minimum without lowering existing limits", async (initial) => {
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-inotify-"));
  directories.push(directory);
  const file = join(directory, "limit");
  await writeFile(file, `${initial}\n`);
  const child = Bun.spawn(["sh", "-c", inotifyMinimumScript, "test", file], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(await readFile(file, "utf8")).toBe(`${Math.max(initial, 8192)}\n`);
});

test("fails if the kernel value cannot be read", async () => {
  const child = Bun.spawn(["sh", "-c", inotifyMinimumScript, "test", "/does-not-exist/limit"], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).not.toBe(0);
});

test("verifies the limit after writing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-inotify-"));
  directories.push(directory);
  await writeFile(join(directory, "cat"), "#!/bin/sh\necho 128\n", { mode: 0o755 });
  const child = Bun.spawn(["sh", "-c", inotifyMinimumScript, "test", join(directory, "limit")], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("inotify limit is still 128");
});

test("runs on the Docker host using the resolved image, without network or pulls", async () => {
  await ensureHostInotifyLimit("sha256:existing", async (args) => {
    expect(args).toEqual([
      "run", "--rm", "--pull=never", "--privileged", "--network=none",
      "--user", "root", "--entrypoint", "/bin/sh", "sha256:existing",
      "-c", inotifyMinimumScript, "agents-in-the-cloud-inotify", "/proc/sys/fs/inotify/max_user_instances",
    ]);
    return { exitCode: 0, stdout: "fs.inotify.max_user_instances=8192\n", stderr: "" };
  });
});

test("surfaces permission failures with remediation", async () => {
  await expect(ensureHostInotifyLimit("image", async () => ({ exitCode: 1, stdout: "", stderr: "Read-only file system" })))
    .rejects.toThrow("set fs.inotify.max_user_instances to at least 8192 on the Docker host, then restart AgentsInTheCloud.\nRead-only file system");
});
