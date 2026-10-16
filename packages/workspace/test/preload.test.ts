import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImagePreloader, normalizeImageReference, defaultWorkspacePreload } from "../src/preload.ts";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const postgres = "docker.io/library/postgres:17";
const redis = "docker.io/library/redis:8";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-preloads-"));
  directories.push(path);
  return path;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(cacheDirectory?: string) {
  const images = new Map<string, string>();
  const registry = new Map([[postgres, digestA], [redis, digestB]]);
  const calls: string[][] = [];
  const imports: { container: string; bytes: Buffer }[] = [];
  const installedReferences: string[] = [];
  let before: ((args: string[]) => Promise<void>) | undefined;
  let dockerBefore: ((args: string[]) => Promise<void>) | undefined;
  const run = async (args: string[]) => {
    calls.push(args);
    await before?.(args);
    let stdout = "";
    if (args[0] === "ctr") {
      const [kind, action, ...rest] = args.slice(3);
      if (kind === "images" && action === "ls") {
        const name = rest[0]!.slice("name==".length);
        stdout = "REF TYPE DIGEST SIZE PLATFORMS LABELS\n";
        if (images.has(name)) stdout += `${name} application/vnd.oci.image.manifest.v1+json ${images.get(name)} 1B linux/amd64 -\n`;
      } else if (kind === "content" && action === "fetch") {
        const digest = registry.get(rest[0]!);
        if (!digest) throw new Error("registry fetch failed");
        images.set(rest[0]!, digest);
      } else if (kind === "images" && action === "tag") {
        images.set(rest[2]!, images.get(rest[1]!)!);
      } else if (!(kind === "images" && action === "build-erofs-cache")) {
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    } else if (args[0] === "agents-in-the-cloud-image-transfer" && args[1] === "export") {
      return { stdout: Buffer.from([0, 255, 127, 42]), stderr: "" };
    } else throw new Error(`Unexpected command: ${args.join(" ")}`);
    return { stdout: Buffer.from(stdout), stderr: "" };
  };
  const docker = async (args: string[], options?: { stdin?: string | Uint8Array }) => {
    calls.push(["docker", ...args]);
    await dockerBefore?.(args);
    if (args[0] === "image" && args[1] === "inspect") return { exitCode: 0, stdout: JSON.stringify([digestA]), stderr: "" };
    throw new Error(`Unexpected docker command: ${args.join(" ")}`);
  };
  const inWorkspace = async (workspaceId: string, argv: string[], stdin?: string | Uint8Array) => {
    calls.push(["workspace", workspaceId, ...argv]);
    await dockerBefore?.(argv);
    if (argv.includes("import")) {
      imports.push({ container: workspaceId, bytes: Buffer.from(stdin!) });
      return `${postgres}@${digestB}\n`;
    }
    if (argv.includes("tee")) installedReferences.push(String(stdin));
    return "";
  };
  const build = async (args: string[]) => { await run(args); };
  return {
    build, preloader: createImagePreloader(run, docker, cacheDirectory, undefined, build, inWorkspace), run, docker, inWorkspace, calls, images, registry, imports, installedReferences,
    before(fn: (args: string[]) => Promise<void>) { before = fn; },
    dockerBefore(fn: (args: string[]) => Promise<void>) { dockerBefore = fn; },
    builds: () => calls.filter((args) => args.includes("build-erofs-cache")),
  };
}

test("normalizes Docker Hub and custom-registry image names", () => {
  expect(normalizeImageReference("postgres")).toBe("docker.io/library/postgres:latest");
  expect(normalizeImageReference("postgres:17")).toBe(postgres);
  expect(normalizeImageReference("team/service:dev")).toBe("docker.io/team/service:dev");
  expect(normalizeImageReference("localhost:5000/team/service")).toBe("localhost:5000/team/service:latest");
  expect(normalizeImageReference(`ghcr.io/team/service@${digestA}`)).toBe(`ghcr.io/team/service@${digestA}`);
  expect(() => normalizeImageReference("postgres:17 other")).toThrow("Invalid image reference");
});

test("snapshots requested settings and persists each exact reference before resolving the next", async () => {
  const f = fixture();
  const path = await directory();
  const settings = ["postgres:17", "redis:8", "postgres:17"];
  await f.preloader.snapshot(settings, path);
  settings.splice(0, settings.length, "different:tag");
  f.registry.delete(redis);
  await expect(f.preloader.load(path)).rejects.toThrow("registry fetch failed");
  const partial = JSON.parse(await readFile(join(path, "preloads.json"), "utf8"));
  expect(partial).toEqual([{ requested: "postgres:17", reference: `${postgres}@${digestA}` }, { requested: "redis:8" }]);
  // Both the registry and source tag change before retry and process restart.
  f.registry.set(postgres, digestB);
  f.images.set(postgres, digestB);
  f.registry.set(redis, digestB);
  const restarted = createImagePreloader(f.run, f.docker, undefined, undefined, f.build, f.inWorkspace);
  expect(await restarted.load(path)).toEqual([
    { requested: "postgres:17", reference: `${postgres}@${digestA}` },
    { requested: "redis:8", reference: `${redis}@${digestB}` },
  ]);
  expect(f.calls.filter((args) => args.includes(`name==${postgres}`))).toHaveLength(2);
});

test("resolves an existing local image without contacting a registry", async () => {
  const f = fixture();
  f.images.set(postgres, digestA);
  const path = await directory();
  await f.preloader.snapshot(["postgres:17"], path);
  expect((await f.preloader.load(path))[0]!.reference).toBe(`${postgres}@${digestA}`);
  expect(f.calls.some((args) => args.includes("fetch"))).toBe(false);
});

test("empty preload lists execute no commands and start neither daemon", async () => {
  const f = fixture();
  const path = await directory();
  await f.preloader.snapshot([], path);
  await f.preloader.install(await f.preloader.load(path), "workspace");
  expect(f.calls).toEqual([]);
});

test("concurrent workspaces share cache preparation and import metadata independently with only containerd started", async () => {
  const f = fixture();
  const started = deferred();
  const release = deferred();
  f.before(async (args) => {
    if (args.includes("build-erofs-cache")) { started.resolve(); await release.promise; }
  });
  const images = [{ requested: "postgres:17", reference: `${postgres}@${digestA}` }];
  const first = f.preloader.install(images, "one");
  await started.promise;
  const second = f.preloader.install(images, "two");
  release.resolve();
  await Promise.all([first, second]);
  expect(f.builds()).toHaveLength(1);
  expect(f.builds()[0]!.at(-1)).toBe("/data/erofs-cache");
  expect(f.imports.map((entry) => entry.container).sort()).toEqual(["one", "two"]);
  for (const imported of f.imports) expect(imported.bytes).toEqual(Buffer.from([0, 255, 127, 42]));
  expect(f.calls.filter((args) => args.includes("systemctl"))).toEqual([
    ["workspace", "one", "systemctl", "start", "containerd.service"],
    ["workspace", "two", "systemctl", "start", "containerd.service"],
  ]);
  expect(f.calls.some((args) => args.includes("dockerd") || args.includes("docker.service"))).toBe(false);
});

test("serializes cache builds for different manifests sharing the cache directory", async () => {
  const f = fixture();
  const started = deferred();
  const release = deferred();
  let active = 0;
  let maximum = 0;
  f.before(async (args) => {
    if (!args.includes("build-erofs-cache")) return;
    maximum = Math.max(maximum, ++active);
    if (args.includes(`${postgres}@${digestA}`)) { started.resolve(); await release.promise; }
    active--;
  });
  const first = f.preloader.install([{ requested: postgres, reference: `${postgres}@${digestA}` }], "one");
  await started.promise;
  const second = f.preloader.install([{ requested: redis, reference: `${redis}@${digestB}` }], "two");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.builds()).toHaveLength(1);
  release.resolve();
  await Promise.all([first, second]);
  expect(maximum).toBe(1);
  expect(f.builds()).toHaveLength(2);
});

test("failed cache preparation propagates, performs no import, and can be retried", async () => {
  const f = fixture();
  let fail = true;
  f.before(async (args) => {
    if (args.includes("build-erofs-cache") && fail) { fail = false; throw new Error("mkfs failed"); }
  });
  const images = [{ requested: postgres, reference: `${postgres}@${digestA}` }];
  await expect(f.preloader.install(images, "one")).rejects.toThrow("mkfs failed");
  expect(f.imports).toEqual([]);
  await f.preloader.install(images, "one");
  expect(f.builds()).toHaveLength(2);
  expect(f.imports).toHaveLength(1);
});

test("import failure propagates and retry reuses successful cache preparation", async () => {
  const f = fixture();
  let fail = true;
  f.dockerBefore(async (args) => {
    if (args.includes("import") && fail) { fail = false; throw new Error("destination unavailable"); }
  });
  const images = [{ requested: postgres, reference: `${postgres}@${digestA}` }];
  await expect(f.preloader.install(images, "one")).rejects.toThrow("destination unavailable");
  await f.preloader.install(images, "one");
  expect(f.builds()).toHaveLength(1);
  expect(f.imports).toHaveLength(1);
});

test("complete cache files survive app restart without repeated conversion", async () => {
  const cache = await directory();
  await mkdir(join(cache, "sha256", "aa"), { recursive: true });
  await writeFile(join(cache, "sha256", "aa", `${"a".repeat(64)}.erofs`), Buffer.alloc(4096));
  const f = fixture(cache);
  const images = [{ requested: postgres, reference: `${postgres}@${digestA}` }];
  await f.preloader.install(images, "one");
  await createImagePreloader(f.run, f.docker, cache, undefined, f.build, f.inWorkspace).install(images, "two");
  expect(f.builds()).toHaveLength(0);
  expect(f.imports.map((entry) => entry.container)).toEqual(["one", "two"]);
});

test("invalid final cache files fail visibly instead of being treated as prepared", async () => {
  const cache = await directory();
  await mkdir(join(cache, "sha256", "aa"), { recursive: true });
  await writeFile(join(cache, "sha256", "aa", `${"a".repeat(64)}.erofs`), "");
  const f = fixture(cache);
  await expect(f.preloader.install([{ requested: postgres, reference: `${postgres}@${digestA}` }], "one")).rejects.toThrow("Invalid cached EROFS layer");
  expect(f.imports).toEqual([]);
  expect(f.builds()).toHaveLength(0);
});

test("concurrent resolution of the same tag fetches once and persists the same digest in both workspaces", async () => {
  const f = fixture();
  const firstPath = await directory();
  const secondPath = await directory();
  await Promise.all([f.preloader.snapshot(["postgres:17"], firstPath), f.preloader.snapshot([postgres], secondPath)]);
  const fetching = deferred();
  const release = deferred();
  f.before(async (args) => {
    if (args.includes("fetch")) { fetching.resolve(); await release.promise; }
  });
  const first = f.preloader.load(firstPath);
  await fetching.promise;
  const second = f.preloader.load(secondPath);
  release.resolve();
  const results = await Promise.all([first, second]);
  expect(results.map((images) => images[0]!.reference)).toEqual([`${postgres}@${digestA}`, `${postgres}@${digestA}`]);
  expect(f.calls.filter((args) => args.includes("fetch"))).toHaveLength(1);
});


test("default workspace alias is pinned at creation and survives a changed app default", async () => {
  const f = fixture();
  f.images.set(postgres, digestA);
  let selected = postgres;
  let resolutions = 0;
  const preloader = createImagePreloader(f.run, f.docker, await directory(), async () => { resolutions++; return selected; }, f.build, f.inWorkspace);
  const path = await directory();
  const referenceFile = await preloader.snapshot([defaultWorkspacePreload, defaultWorkspacePreload], path);
  expect(await readFile(referenceFile!, "utf8")).toBe(`${postgres}@${digestA}\n`);
  selected = redis;
  f.images.set(postgres, digestB);
  const images = await preloader.load(path);
  expect(images).toEqual([{ requested: defaultWorkspacePreload, reference: `${postgres}@${digestA}` }]);
  await preloader.install(images, "workspace");
  expect(f.builds()[0]).toContain(`${postgres}@${digestA}`);
  expect(f.imports).toHaveLength(1);
  expect(f.installedReferences).toEqual([`${postgres}@${digestB}\n`]);
  expect(resolutions).toBe(1);
  expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
  const restarted = createImagePreloader(f.run, f.docker, undefined, undefined, f.build, f.inWorkspace);
  expect(await restarted.load(path)).toEqual(images);
});

test("ordinary preloads do not resolve or expose the default workspace", async () => {
  const f = fixture();
  const preloader = createImagePreloader(f.run, f.docker, await directory(), async () => { throw new Error("must not resolve default"); }, f.build, f.inWorkspace);
  const path = await directory();
  expect(await preloader.snapshot(["postgres:17"], path)).toBeUndefined();
  await expect(readFile(join(path, "agents-in-the-cloud", "default-workspace-image"))).rejects.toThrow();
});

test("cancelling one cache waiter leaves shared preparation available to other workspaces", async () => {
  const { withCommandSignal } = await import("@agents-in-the-cloud/core");
  const f = fixture();
  const started = deferred();
  const release = deferred();
  f.before(async (args) => {
    if (args.includes("build-erofs-cache")) { started.resolve(); await release.promise; }
  });
  const images = [{ requested: "postgres:17", reference: `${postgres}@${digestA}` }];
  const controller = new AbortController();
  const first = withCommandSignal(controller.signal, () => f.preloader.install(images, "one")).catch((error) => error);
  await started.promise;
  const second = f.preloader.install(images, "two");
  controller.abort(new Error("cancelled"));
  expect(await first).toMatchObject({ message: "cancelled" });
  release.resolve();
  await second;
  expect(f.builds()).toHaveLength(1);
  expect(f.imports.map((entry) => entry.container)).toEqual(["two"]);
});

test("cache waiters receive shared progress and cancellation detaches their reporter", async () => {
  const { withCommandSignal } = await import("@agents-in-the-cloud/core");
  const f = fixture();
  const started = deferred();
  const release = deferred();
  const preloader = createImagePreloader(f.run, f.docker, await directory(), undefined, async (_args, report) => {
    report({ terminalSession: "agents-in-the-cloud-provision-image-cache-shared", output: undefined });
    started.resolve();
    await release.promise;
    report({ terminalSession: undefined, output: "Built 1 layer" });
  }, f.inWorkspace);
  const images = [{ requested: postgres, reference: `${postgres}@${digestA}` }];
  const firstProgress: unknown[] = [];
  const secondProgress: unknown[] = [];
  const details: string[] = [];
  const controller = new AbortController();
  const first = withCommandSignal(controller.signal, () => preloader.install(images, "one", detail => details.push(detail), progress => firstProgress.push(progress))).catch(error => error);
  await started.promise;
  const second = preloader.install(images, "two", () => {}, progress => secondProgress.push(progress));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(secondProgress).toContainEqual({ terminalSession: "agents-in-the-cloud-provision-image-cache-shared", output: undefined });
  controller.abort(new Error("cancelled"));
  expect(await first).toMatchObject({ message: "cancelled" });
  const count = firstProgress.length;
  release.resolve();
  await second;
  expect(firstProgress).toHaveLength(count);
  expect(secondProgress).toContainEqual({ terminalSession: undefined, output: "Built 1 layer" });
  expect(secondProgress.at(-1)).toEqual({ terminalSession: undefined, output: undefined });
  expect(details.some(detail => detail.includes("Waiting for image cache preparation queue"))).toBe(true);
  expect(details.some(detail => detail.includes("0/1 layers cached"))).toBe(true);
});
