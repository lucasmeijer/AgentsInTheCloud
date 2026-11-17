import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWorkspaceAttentionStore, createFileWorkspaceDeletionStore, createWorkspaceRegistry, type WorkspaceAttentionSnapshot, type WorkspaceAttentionStore } from "../src/server/workspace-registry.ts";

function memoryAttention(): WorkspaceAttentionStore {
  let state: WorkspaceAttentionSnapshot = { nextSequence: 1, workspaces: {}, surfaces: {} };
  return { async load() { return structuredClone(state); }, async save(next) { state = structuredClone(next); } };
}
async function setup() {
  let clock = 100;
  const attentionStore = memoryAttention();
  const registry = createWorkspaceRegistry({ now: () => clock++, attentionStore });
  await registry.seed([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  return { registry, attentionStore };
}

describe("phase-owned workspace activity", () => {
  test("provisioning is busy only while working and requests attention for decisions and failure", async () => {
    const { registry } = await setup();
    registry.startProvisioning("a");
    expect(registry.get("a")!.phase).toEqual({ kind: "provisioningPhase", status: "working", busy: true });
    registry.setProvisioningState("a", "waiting");
    expect(registry.get("a")!.phase.busy).toBe(false);
    expect(registry.get("a")!.requestingAttention).toBe(true);
    registry.setVisibility("browser", { workspaceId: "a", surfaceKeys: [] });
    registry.setProvisioningState("a", "working");
    registry.setProvisioningState("a", "failed", "setup failed");
    expect(registry.get("a")!.phase).toMatchObject({ status: "failed", busy: false, error: "setup failed" });
    expect(registry.get("a")!.requestingAttention).toBe(false);
  });
  test("running activity aggregates agents, never work views", async () => {
    const { registry } = await setup();
    registry.setAgentBusy("a", "agent:first", true);
    registry.setAgentBusy("a", "agent:second", true);
    registry.setAgentBusy("a", "agent:first", false);
    expect(registry.get("a")!.phase).toEqual({ kind: "runningPhase", busy: true });
    registry.setAgentBusy("a", "agent:second", false);
    expect(registry.get("a")!.phase.busy).toBe(false);
    expect(() => registry.setAgentBusy("a", "terminal:one", true)).toThrow("Not an agent");
  });
  test.each([
    { status: "blocked", fingerprint: "changes" },
    { status: "failed", operation: "deleting", forced: false, error: "disk" },
  ] as const)("active destruction rejects attention until deletion becomes $status", async (decision) => {
    const { registry, attentionStore } = await setup();
    registry.setAgentBusy("a", "agent:first", true);
    registry.setDeletion("a", { status: "deleting", forced: false });

    registry.setAgentBusy("a", "agent:first", false);
    registry.requestAttention("a");
    expect(registry.get("a")!.phase.busy).toBe(true);
    expect(registry.get("a")!.requestingAttention).toBe(false);
    expect(registry.get("a")!.attentionAt).toBeUndefined();
    expect((await attentionStore.load()).workspaces).toEqual({});

    registry.setDeletion("a", decision);
    expect(registry.get("a")!.phase.busy).toBe(false);
    expect(registry.get("a")!.requestingAttention).toBe(true);
    expect((await attentionStore.load()).workspaces.a).toBeDefined();
  });
  test("deletion exclusively owns busy state even with busy agents", async () => {
    const { registry } = await setup();
    registry.setAgentBusy("a", "agent:first", true);
    registry.setDeletion("a", { status: "checking" });
    expect(registry.get("a")!.phase).toMatchObject({ kind: "deletingPhase", busy: true });
    registry.setDeletion("a", { status: "blocked", fingerprint: "one" });
    expect(registry.get("a")!.phase.busy).toBe(false);
    expect(registry.get("a")!.requestingAttention).toBe(true);
    registry.setDeletion("a", { status: "deleting", forced: true });
    expect(registry.get("a")!.phase.busy).toBe(true);
    registry.setDeletion("a", { status: "failed", operation: "deleting", forced: true, error: "disk" });
    expect(registry.get("a")!.phase.busy).toBe(false);
    expect(() => registry.startProvisioning("a")).toThrow();
    expect(() => registry.startRunning("a")).toThrow();
    registry.cancelDeletion("a");
    expect(registry.get("a")!.phase).toEqual({ kind: "runningPhase", busy: true });
  });
});

describe("independent attention and visibility", () => {
  test("surface attention stays local whether agents are busy or idle", async () => {
    const { registry } = await setup();
    registry.setAgentBusy("a", "agent:first", true);
    registry.requestSurfaceAttention("a", "browser:first");
    expect(registry.surfaceState("a", "browser:first").requestingAttention).toBe(true);
    expect(registry.get("a")!.requestingAttention).toBe(false);
    registry.setAgentBusy("a", "agent:first", false);
    expect(registry.get("a")!.requestingAttention).toBe(false);
    registry.requestSurfaceAttention("a", "terminal:first");
    registry.requestSurfaceAttention("a", "agent:first");
    expect(registry.get("a")!.requestingAttention).toBe(false);
    registry.requestAttention("a");
    const attentionAt = registry.get("a")!.attentionAt;
    expect(registry.get("a")!.requestingAttention).toBe(true);
    registry.requestSurfaceAttention("a", "browser:second");
    expect(registry.get("a")!.attentionAt).toBe(attentionAt);
  });
  test("workspace visibility clears only workspace attention, not its agents or views", async () => {
    const { registry } = await setup();
    registry.requestSurfaceAttention("a", "agent:first");
    registry.requestSurfaceAttention("a", "browser:first");
    registry.requestAttention("a");
    expect(registry.get("a")!.requestingAttention).toBe(true);
    registry.setVisibility("browser", { workspaceId: "a", surfaceKeys: [] });
    expect(registry.get("a")!.requestingAttention).toBe(false);
    expect(registry.agentState("a", "agent:first").requestingAttention).toBe(true);
    expect(registry.surfaceState("a", "browser:first").requestingAttention).toBe(true);
    registry.setVisibility("browser", { workspaceId: "a", surfaceKeys: ["agent:first"] });
    expect(registry.agentState("a", "agent:first").requestingAttention).toBe(false);
    expect(registry.surfaceState("a", "browser:first").requestingAttention).toBe(true);
  });
  test("hidden agents and views can request attention inside a visible workspace without selecting them", async () => {
    const { registry } = await setup();
    registry.setVisibility("browser", { workspaceId: "a", surfaceKeys: ["agent:first", "browser:first"] });
    for (const key of ["agent:first", "browser:first", "agent:second", "browser:second"]) registry.requestSurfaceAttention("a", key);
    expect(registry.surfaceState("a", "agent:first").requestingAttention).toBe(false);
    expect(registry.surfaceState("a", "browser:first").requestingAttention).toBe(false);
    expect(registry.surfaceState("a", "agent:second").requestingAttention).toBe(true);
    expect(registry.surfaceState("a", "browser:second").requestingAttention).toBe(true);
    expect(registry.get("a")!.requestingAttention).toBe(false);
    registry.setVisibility("browser", { workspaceId: "b", surfaceKeys: [] });
    expect(registry.get("a")!.requestingAttention).toBe(false);
    registry.requestSurfaceAttention("a", "agent:third");
    expect(registry.get("a")!.requestingAttention).toBe(false);
  });
  test("visibility is the union of live browser connections, released on disconnect", async () => {
    const { registry } = await setup();
    registry.setVisibility("one", { workspaceId: "a", surfaceKeys: ["agent:first"] });
    registry.setVisibility("two", { workspaceId: "a", surfaceKeys: ["browser:first"] });
    registry.disconnect("one");
    registry.requestSurfaceAttention("a", "agent:first");
    registry.requestSurfaceAttention("a", "browser:first");
    expect(registry.surfaceState("a", "agent:first").requestingAttention).toBe(true);
    expect(registry.surfaceState("a", "browser:first").requestingAttention).toBe(false);
    expect(registry.get("a")!.requestingAttention).toBe(false);
    registry.disconnect("two");
    registry.requestSurfaceAttention("a", "browser:first");
    expect(registry.surfaceState("a", "browser:first").requestingAttention).toBe(true);
    expect(registry.get("a")!.requestingAttention).toBe(false);
  });
  test("repeat requests keep oldest-first ordering, including busy workspaces", async () => {
    const { registry } = await setup();
    registry.requestSurfaceAttention("b", "agent:first");
    registry.requestAttention("b");
    const first = registry.surfaceState("b", "agent:first").attentionSequence;
    const attentionAt = registry.get("b")!.attentionAt;
    registry.setAgentBusy("b", "agent:first", true);
    registry.requestAttention("a");
    registry.requestSurfaceAttention("b", "agent:first");
    registry.requestAttention("b");
    registry.touch("a");
    expect(registry.surfaceState("b", "agent:first").attentionSequence).toBe(first);
    expect(registry.get("b")!.attentionAt).toBe(attentionAt);
    expect(registry.list().map(({ id }) => id)).toEqual(["b", "a"]);
    expect(registry.oldestAttentionWorkspace()?.id).toBe("b");
    registry.setVisibility("browser", { workspaceId: "b", surfaceKeys: ["agent:first"] });
    registry.disconnect("browser");
    registry.requestSurfaceAttention("b", "agent:first");
    registry.requestAttention("b");
    expect(registry.surfaceState("b", "agent:first").attentionSequence).toBeGreaterThan(first!);
    expect(registry.oldestAttentionWorkspace()?.id).toBe("a");
  });
  test("attention and busy activity unpark; changes notify only the affected row", async () => {
    const { registry } = await setup();
    registry.setParked("a", true);
    const rows: string[] = [];
    const lists: unknown[] = [];
    registry.setCallbacks({ rowChanged: (entry) => rows.push(entry.id), listChanged: () => lists.push("changed") });
    registry.requestSurfaceAttention("a", "browser:first");
    expect(registry.get("a")!.parked).toBe(false);
    registry.setTitle("a", "New title");
    registry.touch("a");
    expect(rows.every((id) => id === "a")).toBe(true);
    expect(lists).toEqual([]);
  });
  test("workspace and surface attention persist independently across restart", async () => {
    const { registry, attentionStore } = await setup();
    registry.requestSurfaceAttention("a", "agent:first");
    registry.setVisibility("browser", { workspaceId: "a", surfaceKeys: [] });
    registry.requestAttention("b");
    const restarted = createWorkspaceRegistry({ attentionStore });
    await restarted.seed([{ id: "a", title: null }, { id: "b", title: null }]);
    expect(restarted.get("a")!.requestingAttention).toBe(false);
    expect(restarted.surfaceState("a", "agent:first").requestingAttention).toBe(true);
    expect(restarted.get("b")!.requestingAttention).toBe(true);
    restarted.remove("a");
    expect(restarted.surfaceState("a", "agent:first").requestingAttention).toBe(false);
  });
});

test("attention file writes capture nested state at invocation and preserve write order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-attention-"));
  try {
    const store = createFileWorkspaceAttentionStore(join(directory, "attention.json"));
    const state: WorkspaceAttentionSnapshot = { nextSequence: 2, workspaces: { a: 100 }, surfaces: { a: { "agent:one": { sequence: 1 } } } };
    const first = store.save(state);
    state.surfaces.a!["agent:one"]!.sequence = 2;
    await first;
    expect((await store.load()).surfaces.a!["agent:one"]!.sequence).toBe(1);
    const second = store.save(state);
    delete state.surfaces.a;
    const third = store.save(state);
    await Promise.all([second, third]);
    expect((await store.load()).surfaces).toEqual({});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancelling deletion of interrupted provisioning returns to a non-busy provisioning failure", async () => {
  const { registry } = await setup();
  registry.startProvisioning("a");
  registry.setDeletion("a", { status: "blocked", fingerprint: "changes" });
  registry.cancelDeletion("a");
  expect(registry.get("a")!.phase).toEqual({ kind: "provisioningPhase", status: "failed", busy: false, error: "Workspace preparation was cancelled. Delete this workspace or restart AgentsInTheCloud to retry startup." });
});


test("deletion retries and restart preserve the provisioning failure to restore on cancellation", async () => {
  let saved = {};
  const deletionStore = { async load() { return saved; }, async save(values: typeof saved) { saved = structuredClone(values); } };
  const registry = createWorkspaceRegistry({ deletionStore });
  await registry.seed([{ id: "broken", title: null }]);
  registry.startProvisioning("broken");
  registry.setProvisioningState("broken", "failed", "Container unavailable");
  registry.setDeletion("broken", { status: "deleting", forced: true });
  registry.setDeletion("broken", { status: "failed", operation: "deleting", forced: true, error: "Cannot delete" });
  const restarted = createWorkspaceRegistry({ deletionStore });
  await restarted.seed([{ id: "broken", title: null }]);
  restarted.cancelDeletion("broken");
  expect(restarted.get("broken")!.phase).toEqual({ kind: "provisioningPhase", status: "failed", busy: false, error: "Container unavailable" });
});


test("deletion persistence retains the interrupted provisioning failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-deletion-"));
  try {
    const store = createFileWorkspaceDeletionStore(join(directory, "deletion.json"));
    await store.save({ broken: { status: "failed", operation: "deleting", forced: true, error: "Cannot delete", provisioningError: "Container unavailable" } });
    const registry = createWorkspaceRegistry({ deletionStore: store });
    await registry.seed([{ id: "broken", title: null }]);
    registry.cancelDeletion("broken");
    expect(registry.get("broken")!.phase).toEqual({ kind: "provisioningPhase", status: "failed", busy: false, error: "Container unavailable" });
    await store.save({});
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("rechecking a blocked deletion after restart retains its interrupted provisioning phase", async () => {
  const registry = createWorkspaceRegistry({ deletionStore: {
    async load() { return { broken: { status: "blocked", fingerprint: "previous", provisioningError: "Preparation interrupted" } }; },
    async save() {},
  } });
  await registry.seed([{ id: "broken", title: null }]);
  expect(registry.get("broken")!.phase).toMatchObject({ kind: "deletingPhase", deletion: { status: "checking" } });
  registry.setDeletion("broken", { status: "blocked", fingerprint: "current" });
  registry.cancelDeletion("broken");
  expect(registry.get("broken")!.phase).toEqual({ kind: "provisioningPhase", status: "failed", busy: false, error: "Preparation interrupted" });
});

test("parked workspaces sort after active workspaces regardless of attention or recent activity", async () => {
  const { registry } = await setup();
  registry.requestAttention("a");
  registry.touch("a");
  registry.setParked("a", true);
  expect(registry.list().map(({ id }) => id)).toEqual(["b", "a"]);
  registry.setParked("a", false);
  expect(registry.list().map(({ id }) => id)).toEqual(["a", "b"]);
});

test("active workspaces without attention sort idle before busy, then by recent activity", async () => {
  let clock = 100;
  const registry = createWorkspaceRegistry({ now: () => clock++ });
  await registry.seed(["idle-old", "idle-new", "busy-old", "busy-new"].map((id) => ({ id, title: id })));
  for (const id of ["idle-old", "idle-new", "busy-old", "busy-new"]) registry.touch(id);
  registry.setAgentBusy("busy-old", "agent:first", true);
  registry.setAgentBusy("busy-new", "agent:first", true);
  expect(registry.list().map(({ id }) => id)).toEqual(["idle-new", "idle-old", "busy-new", "busy-old"]);

  registry.setAgentBusy("busy-new", "agent:first", false);
  expect(registry.list().map(({ id }) => id)).toEqual(["busy-new", "idle-new", "idle-old", "busy-old"]);

  registry.requestAttention("busy-old");
  expect(registry.list().map(({ id }) => id)).toEqual(["busy-old", "busy-new", "idle-new", "idle-old"]);
});

test("busy-last ordering does not change the order within parked workspaces", async () => {
  const { registry } = await setup();
  registry.setAgentBusy("b", "agent:first", true);
  registry.touch("b");
  registry.setParked("a", true);
  registry.setParked("b", true);
  expect(registry.list().map(({ id }) => id)).toEqual(["b", "a"]);
});
