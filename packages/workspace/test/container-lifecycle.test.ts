import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceContainerLifecycle } from "../src/container-lifecycle.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-lifecycle-"));
  const directory = join(root, "configuration");
  const calls: string[][] = [];
  const sources = [join(root, "init.sh"), join(root, "agents-in-the-cloud")] as const;
  await writeFile(sources[0], "original init");
  await mkdir(sources[1]);
  await writeFile(join(sources[1], "docker-support"), "disabled");
  const files = [{ source: sources[0], target: "/.agents-in-the-cloud/init.sh" }, { source: sources[1], target: "/etc" }];
  const lifecycle = (overrides: Partial<Parameters<typeof createWorkspaceContainerLifecycle>[0]> = {}) => createWorkspaceContainerLifecycle({
    directory, container: "workspace", checkpointRequired: true,
    async docker(args) { calls.push(args); return { stdout: "", stderr: "", exitCode: 0 }; },
    async started() { calls.push(["started"]); },
    async waitForStartup() { calls.push(["ready"]); return "startup log"; },
    ...overrides,
  });
  return { directory, sources, files, calls, lifecycle,
    checkpoint: async () => JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8")),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}

test("recovery uses frozen sources and copies everything before starting", async () => {
  const f = await fixture();
  try {
    await f.lifecycle().snapshot(f.files);
    expect((await f.checkpoint()).phase).toBe("configuring");
    await writeFile(f.sources[0], "changed settings");
    await rm(f.sources[1], { recursive: true });
    // A new module instance stands in for a replacement app process.
    expect(await f.lifecycle().ensureStarted()).toBe("startup log");
    const checkpoint = await f.checkpoint();
    expect(checkpoint.phase).toBe("configured");
    expect(await readFile(checkpoint.files[0].source, "utf8")).toBe("original init");
    expect(await readFile(join(checkpoint.files[1].source, "docker-support"), "utf8")).toBe("disabled");
    expect(checkpoint.files[1].source.endsWith("/agents-in-the-cloud")).toBe(true);
    expect(f.calls).toEqual([
      ["cp", checkpoint.files[0].source, "workspace:/.agents-in-the-cloud/init.sh"],
      ["cp", checkpoint.files[1].source, "workspace:/etc"], ["start", "workspace"], ["started"], ["ready"],
    ]);
  } finally { await f.clean(); }
});

test("an interrupted copy cannot start the container; recovery replays the whole snapshot", async () => {
  const f = await fixture();
  try {
    const interrupted = f.lifecycle({ async docker(args) {
      f.calls.push(args);
      if (f.calls.length === 2) throw new Error("process interrupted");
      return { stdout: "", stderr: "", exitCode: 0 };
    } });
    await interrupted.snapshot(f.files);
    await expect(interrupted.ensureStarted()).rejects.toThrow("process interrupted");
    expect((await f.checkpoint()).phase).toBe("configuring");
    expect(f.calls.every(([command]) => command === "cp")).toBe(true);
    f.calls.length = 0;
    await f.lifecycle().ensureStarted();
    expect(f.calls.map(([command]) => command)).toEqual(["cp", "cp", "start", "started", "ready"]);
  } finally { await f.clean(); }
});

test("the configured checkpoint precedes start and startup failures never replay copies", async () => {
  const f = await fixture();
  try {
    const first = f.lifecycle({
      async docker(args) {
        if (args[0] === "start") expect((await f.checkpoint()).phase).toBe("configured");
        f.calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async waitForStartup() { throw new Error("init failed"); },
    });
    await first.snapshot(f.files);
    await expect(first.ensureStarted()).rejects.toThrow("init failed");
    expect((await f.checkpoint()).phase).toBe("configured");
    f.calls.length = 0;
    await f.lifecycle().ensureStarted();
    expect(f.calls).toEqual([["start", "workspace"], ["started"], ["ready"]]);
    expect((await f.checkpoint()).phase).toBe("configured");
    f.calls.length = 0;
    await f.lifecycle().ensureStarted();
    expect(f.calls).toEqual([["start", "workspace"], ["started"], ["ready"]]);
  } finally { await f.clean(); }
});

test("a failed Docker start retains configuration for a replacement process", async () => {
  const f = await fixture();
  try {
    const lifecycle = f.lifecycle({ async docker(args) {
      if (args[0] === "start") throw new Error("start interrupted");
      return { stdout: "", stderr: "", exitCode: 0 };
    } });
    await lifecycle.snapshot(f.files);
    await expect(lifecycle.ensureStarted()).rejects.toThrow("start interrupted");
    expect((await f.checkpoint()).phase).toBe("configured");
    await f.lifecycle().ensureStarted();
    expect(f.calls).toEqual([["start", "workspace"], ["started"], ["ready"]]);
  } finally { await f.clean(); }
});

test("missing or invalid checkpoints on new containers fail before Docker start", async () => {
  const f = await fixture();
  try {
    await expect(f.lifecycle().ensureStarted()).rejects.toThrow("Missing configuration checkpoint");
    await mkdir(f.directory);
    await writeFile(join(f.directory, "checkpoint.json"), JSON.stringify({ phase: "bogus", files: [] }));
    await expect(f.lifecycle().ensureStarted()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  } finally { await f.clean(); }
});

test("existing containers without checkpoints retain their existing start path", async () => {
  const f = await fixture();
  try {
    await f.lifecycle({ checkpointRequired: false }).ensureStarted();
    expect(f.calls).toEqual([["start", "workspace"], ["started"]]);
  } finally { await f.clean(); }
});

test("independent lifecycle instances share serialization and copy the snapshot once", async () => {
  const f = await fixture();
  try {
    await f.lifecycle().snapshot(f.files);
    await Promise.all([f.lifecycle().ensureStarted(), f.lifecycle().ensureStarted()]);
    expect(f.calls.map(([command]) => command)).toEqual(["cp", "cp", "start", "started", "ready", "start", "started", "ready"]);
  } finally { await f.clean(); }
});

test("earlier running checkpoints remain configured without replaying file copies", async () => {
  const f = await fixture();
  try {
    await f.lifecycle().snapshot(f.files);
    const checkpoint = await f.checkpoint();
    checkpoint.phase = "running";
    await writeFile(join(f.directory, "checkpoint.json"), JSON.stringify(checkpoint));
    await f.lifecycle().ensureStarted();
    expect(f.calls).toEqual([["start", "workspace"], ["started"], ["ready"]]);
  } finally { await f.clean(); }
});
