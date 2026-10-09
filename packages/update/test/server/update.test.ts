import { createAgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateManager, createUpdateRouteHandler, type UpdateManagerDeps } from "../../src/server/index.ts";
import { readStoredUpdateChannel, writeStoredUpdateChannel } from "../../src/server/settings-store.ts";
import { requestSupervisorUpdate } from "../../src/server/supervisor.ts";

function context() {
  const sidebar: string[] = [];
  const broadcasts: string[] = [];
  return {
    sidebar,
    broadcasts,
    ctx: {
      events: createAgentsInTheCloudEventBus(),
      registry: { setAgentBusy: () => {}, requestSurfaceAttention: () => undefined, requestAttention: () => undefined },
      globalSidebarContributions: { set: (_id: string, html?: string, regions?: readonly import("@agents-in-the-cloud/shared").LiveRegion[]) => {
        sidebar.push(html ?? "");
        broadcasts.push(regions?.map(region => region.html).join("") ?? "");
      } },
      createWorkView: async () => {},
      presentWorkView: async () => {},
      invalidateWorkspace: () => {},
      deleteCurrentWorkspace: async () => ({ deleted: false, blocked: false }),
      registerSocketHandler: () => {},
      publishWorkspacePort: async () => { throw new Error("not used"); },
      registerWorkspaceAppResolver: () => {},
      registerProvisioningHook: () => {},
      onWorkspaceRemoved: () => {},
    },
  };
}

function noInterval() {}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const oldDigest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;
const newerDigest = `sha256:${"c".repeat(64)}`;
const exact = `ghcr.io/lucasmeijer/agents-in-the-cloud@${newDigest}`;
function manager(extra: UpdateManagerDeps = {}) {
  return new UpdateManager({
    detectRuntime: async () => ({ currentDigest: oldDigest }),
    fetchMetadata: async () => ({ digest: newDigest }),
    prepareUpdate: async (reference) => ({ reference, imageId: "sha256:prepared-image-id" }),
    setInterval: noInterval, ...extra,
  });
}
test("non-System installations neither discover updates nor accept update operations", async () => {
  const instance = manager({ detectRuntime: async () => undefined, fetchMetadata: async () => { throw new Error("must not check"); } });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().selfUpdatable).toBe(false);
  expect(() => instance.startPull()).toThrow("System-managed");
  const route = createUpdateRouteHandler(instance);
  for (const path of ["/update/start", "/update/restart", "/update/check-now", "/settings/update-channel"]) {
    const url = new URL(path, "http://localhost");
    expect((await route(new Request(url, { method: "POST" }), url))!.status).toBe(409);
  }
});
test("download remains in progress until all preparation completes; restart uses the exact prepared image", async () => {
  const gate = deferred();
  const requests: string[] = [];
  const instance = manager({ prepareUpdate: async (reference, progress) => {
    expect(reference).toBe(exact);
    progress({ kind: "progress", percent: 60, message: "Downloading workspace image" });
    await gate.promise;
    return { reference, imageId: "sha256:prepared-image-id" };
  }, requestUpdate: async (image) => { requests.push(image); } });
  await instance.initialize(context().ctx);
  const pull = instance.startPull();
  expect(instance.startPull()).toBe(pull);
  expect(instance.snapshot()).toMatchObject({ state: "pulling", percent: 60 });
  await expect(instance.restart()).rejects.toThrow("No prepared update");
  await expect(instance.setUpdateChannel("latest")).rejects.toThrow("in progress");
  gate.resolve(); await pull;
  expect(instance.snapshot().state).toBe("ready_to_restart");
  await instance.restart();
  expect(requests).toEqual(["sha256:prepared-image-id"]);
  expect(instance.snapshot().state).toBe("restarting");
  await expect(instance.restart()).rejects.toThrow("already in progress");
});
test("preparation failure keeps the old app running and offers a retry", async () => {
  let attempts = 0;
  const instance = manager({ prepareUpdate: async (reference) => {
    if (++attempts === 1) throw new Error("workspace image unavailable");
    return { reference, imageId: "sha256:prepared" };
  }, requestUpdate: async () => { throw new Error("must not restart while preparing"); } });
  await instance.initialize(context().ctx);
  await instance.startPull();
  expect(instance.snapshot()).toMatchObject({ state: "failed", error: "workspace image unavailable" });
  await expect(instance.restart()).rejects.toThrow("No prepared update");
  await instance.startPull();
  expect(instance.snapshot()).toMatchObject({ state: "ready_to_restart", error: undefined });
});
test("supervisor failure keeps prepared image available for retry", async () => {
  let requests = 0;
  const instance = manager({ requestUpdate: async () => { if (++requests === 1) throw new Error("supervisor busy"); } });
  await instance.initialize(context().ctx); await instance.startPull();
  await expect(instance.restart()).rejects.toThrow("supervisor busy");
  expect(instance.snapshot()).toMatchObject({ state: "ready_to_restart", error: "supervisor busy" });
  await instance.restart();
  expect(requests).toBe(2);
});
test("restart route acknowledges same-origin reload only after supervisor acceptance", async () => {
  const accepted = deferred();
  const instance = manager({ requestUpdate: async () => accepted.promise });
  await instance.initialize(context().ctx); await instance.startPull();
  const route = createUpdateRouteHandler(instance);
  const url = new URL("https://agents-in-the-cloud.example/update/restart?surface=settings");
  const pending = route(new Request(url, { method: "POST" }), url);
  expect(instance.snapshot().state).toBe("restarting");
  accepted.resolve();
  const response = (await pending)!;
  expect(response.status).toBe(204);
  expect(response.headers.get("x-agents-in-the-cloud-reload")).toBe("true");
  expect(response.headers.has("location")).toBe(false);
});
test("background checks cannot replace a pinned download or prepared target", async () => {
  const pendingCheck = deferred<{ digest: string }>();
  let checks = 0;
  const instance = manager({ fetchMetadata: async () => ++checks === 1 ? { digest: newDigest } : pendingCheck.promise });
  await instance.initialize(context().ctx);
  const stale = instance.checkNow();
  await instance.startPull();
  pendingCheck.resolve({ digest: newerDigest });
  await stale;
  await instance.checkNow();
  expect(instance.snapshot().target!.digest).toBe(newDigest);
  expect(instance.snapshot().state).toBe("ready_to_restart");
  expect(checks).toBe(2);
});
test("channel changes persist, discard prior prepared images, and survive manager restart", async () => {
  const previous = process.env.ATELIER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-update-settings-"));
  process.env.ATELIER_DATA_DIR = directory;
  try {
    await writeStoredUpdateChannel("stable");
    expect(JSON.parse(await readFile(join(directory, "update.json"), "utf8"))).toEqual({ releaseChannel: "stable" });
    const dependencies = { readChannel: readStoredUpdateChannel, writeChannel: writeStoredUpdateChannel };
    const instance = manager(dependencies);
    await instance.initialize(context().ctx); await instance.startPull();
    await instance.setUpdateChannel("latest");
    await expect(instance.restart()).rejects.toThrow("No prepared update");
    const restarted = manager(dependencies);
    await restarted.initialize(context().ctx);
    expect(restarted.snapshot().updateChannel).toBe("latest");
    expect(JSON.parse(await readFile(join(directory, "update.json"), "utf8"))).toEqual({ releaseChannel: "latest" });
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
test("a superseded channel check cannot publish success or failure", async () => {
  for (const fail of [false, true]) {
    const pending = deferred<{ digest: string }>();
    const instance = manager({ readChannel: async () => "stable", fetchMetadata: async (channel) => channel === "latest" ? pending.promise : { digest: newDigest } });
    await instance.initialize(context().ctx);
    const stale = instance.setUpdateChannel("latest");
    await Bun.sleep(0);
    await instance.setUpdateChannel("stable");
    const snapshot = instance.snapshot();
    if (fail) pending.reject(new Error("registry failed")); else pending.resolve({ digest: newerDigest });
    await stale;
    expect(instance.snapshot()).toEqual(snapshot);
  }
});
test("supervisor protocol sends only immutable image ID and requires acceptance", async () => {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:3001/update");
    expect(JSON.parse(String(init!.body))).toEqual({ image: "sha256:prepared" });
    return Response.json({ accepted: true }, { status: 202 });
  });
  await requestSupervisorUpdate("sha256:prepared", fetcher);
  await expect(requestSupervisorUpdate("sha256:prepared", async () => new Response("busy", { status: 409 }))).rejects.toThrow("busy");
});

test("new installations discover latest updates and pin their immutable image", async () => {
  const channels: string[] = [];
  const prepared: string[] = [];
  const instance = manager({
    readChannel: async () => undefined,
    fetchMetadata: async (channel) => { channels.push(channel); return { digest: newDigest }; },
    prepareUpdate: async (reference) => { prepared.push(reference); return { reference, imageId: "sha256:latest-image" }; },
  });
  expect(instance.snapshot().updateChannel).toBe("latest");
  await instance.initialize(context().ctx);
  expect(instance.snapshot()).toMatchObject({ updateChannel: "latest", state: "available" });
  expect(channels).toEqual(["latest"]);
  await instance.startPull();
  expect(prepared).toEqual([exact]);
  expect(instance.snapshot().state).toBe("ready_to_restart");
});

test.each(["stable", "latest"] as const)("stored %s channel overrides the latest default", async (channel) => {
  const channels: string[] = [];
  const instance = manager({
    readChannel: async () => channel,
    fetchMetadata: async (selected) => { channels.push(selected); return { digest: newDigest }; },
  });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().updateChannel).toBe(channel);
  expect(channels).toEqual([channel]);
});

test("switching from stable to latest persists the channel and refreshes the target", async () => {
  const previous = process.env.ATELIER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-latest-settings-"));
  process.env.ATELIER_DATA_DIR = directory;
  try {
    await writeStoredUpdateChannel("stable");
    const channels: string[] = [];
    const dependencies = {
      readChannel: readStoredUpdateChannel,
      writeChannel: writeStoredUpdateChannel,
      fetchMetadata: async (channel: "stable" | "latest" | "custom") => {
        channels.push(channel);
        return { digest: channel === "latest" ? newerDigest : newDigest };
      },
    };
    const instance = manager(dependencies);
    await instance.initialize(context().ctx);
    await instance.startPull();
    await instance.setUpdateChannel("latest");
    expect(channels).toEqual(["stable", "latest"]);
    expect(instance.snapshot()).toMatchObject({ updateChannel: "latest", state: "available", target: { digest: newerDigest } });
    await expect(instance.restart()).rejects.toThrow("No prepared update");
    expect(await readStoredUpdateChannel()).toBe("latest");
    const restarted = manager(dependencies);
    await restarted.initialize(context().ctx);
    expect(restarted.snapshot().updateChannel).toBe("latest");
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("fork updates pin the configured app repository rather than upstream", async () => {
  const releaseSource = { appRepository: "ghcr.io/example/fork-app", systemRepository: "ghcr.io/example/fork-system" };
  const references: string[] = [];
  const instance = manager({ readSource: async () => releaseSource, prepareUpdate: async reference => { references.push(reference); return { reference, imageId: "prepared" }; } });
  await instance.initialize(context().ctx);
  await instance.startPull();
  expect(references).toEqual([`ghcr.io/example/fork-app@${newDigest}`]);
  instance.snapshot().releaseSource.appRepository = "ghcr.io/other/app";
  expect(instance.snapshot().releaseSource.appRepository).toBe(releaseSource.appRepository);
});

test("changing source persists and discards the old prepared target", async () => {
  const saved: string[] = [];
  const instance = manager({ writeSource: async source => { saved.push(source.appRepository); } });
  await instance.initialize(context().ctx);
  await instance.startPull();
  await instance.setReleaseSource({ appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system", appVersion: "v1" });
  expect(saved).toEqual(["ghcr.io/example/app"]);
  expect(instance.snapshot().state).toBe("available");
  await expect(instance.restart()).rejects.toThrow("No prepared update");
});

test("JSON source and update controls return JSON without Turbo markup", async () => {
  const instance = manager();
  await instance.initialize(context().ctx);
  const handler = createUpdateRouteHandler(instance);
  for (const [path, method, body] of [
    ["/settings/release-source", "GET", undefined],
    ["/update/status", "GET", undefined],
    ["/settings/release-source", "POST", JSON.stringify({ appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system" })],
    ["/settings/update-channel", "POST", JSON.stringify({ channel: "stable" })],
    ["/update/check-now", "POST", "{}"],
  ] as const) {
    const url = new URL(path, "http://localhost");
    const response = (await handler(new Request(url, { method, body, headers: { accept: "application/json", "content-type": "application/json" } }), url))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  }
});

test("Custom selection survives upstream selection and restores the saved source", async () => {
  const previous = process.env.ATELIER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "custom-channel-"));
  process.env.ATELIER_DATA_DIR = directory;
  try {
    const { readStoredReleaseSource, writeStoredReleaseSource } = await import("../../src/server/settings-store.ts");
    await writeStoredReleaseSource({ appRepository: "docker.io/example/app", systemRepository: "ghcr.io/example/system", appVersion: "v2" });
    expect(await readStoredUpdateChannel()).toBe("custom");
    await writeStoredUpdateChannel("stable");
    expect(await readStoredUpdateChannel()).toBe("stable");
    expect((await readStoredReleaseSource())!.appRepository).toBe("docker.io/example/app");
    await writeStoredUpdateChannel("custom");
    expect(await readStoredUpdateChannel()).toBe("custom");
    const instance = manager({ readChannel: readStoredUpdateChannel, readSource: readStoredReleaseSource, writeChannel: writeStoredUpdateChannel });
    await instance.initialize(context().ctx);
    expect(instance.snapshot().updateChannel).toBe("custom");
    await instance.setUpdateChannel("latest");
    const references: string[] = [];
    const upstream = manager({ readChannel: readStoredUpdateChannel, readSource: readStoredReleaseSource, prepareUpdate: async reference => { references.push(reference); return { reference, imageId: "test" }; } });
    await upstream.initialize(context().ctx); await upstream.startPull();
    expect(references).toEqual([exact]);
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid release configuration disables updates without aborting app initialization", async () => {
  const instance = manager({ readSource: async () => { throw new Error("Invalid release settings"); } });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().state).toBe("failed");
  expect(instance.snapshot().error).toBe("Invalid release settings");
  expect(() => instance.startPull()).toThrow("No update is available");
  await instance.setReleaseSource({ appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system" });
  expect(instance.snapshot().updateChannel).toBe("custom");
  expect(instance.snapshot().state).toBe("available");
});

test("unchanged revision does not report a platform/index digest difference as an update", async () => {
  const instance = manager({ detectRuntime: async () => ({ currentDigest: oldDigest, currentRevision: "same" }), fetchMetadata: async () => ({ digest: newDigest, revision: "same" }) });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().state).toBe("idle");
});

test("saving a source returns success even if its subsequent registry check fails", async () => {
  let fail = false;
  const instance = manager({ fetchMetadata: async () => { if (fail) throw new Error("Registry unavailable"); return { digest: newDigest }; } });
  await instance.initialize(context().ctx); fail = true;
  const url = new URL("http://localhost/settings/release-source");
  const response = (await createUpdateRouteHandler(instance)(new Request(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system" }) }), url))!;
  expect(response.status).toBe(200);
  expect(instance.snapshot().state).toBe("failed");
  expect(instance.snapshot().updateChannel).toBe("custom");
});

test("unlabelled images compare the running index digest with the remote index", async () => {
  const instance = manager({ detectRuntime: async () => ({ currentDigest: oldDigest }), fetchMetadata: async () => ({ digest: newDigest, indexDigest: oldDigest }) });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().state).toBe("idle");
});
