import { readFile } from "node:fs/promises";
import { isNotFoundError, writeFileAtomic } from "@agents-in-the-cloud/core";
import type { WorkspaceVisibilityReport } from "@agents-in-the-cloud/shared";
import type { WorkspaceInitInstruction } from "@agents-in-the-cloud/workspace";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export type WorkspacePhase =
  | { kind: "provisioningPhase"; status: "working" | "waiting" | "failed"; busy: boolean; error?: string; deletion?: never }
  | { kind: "runningPhase"; busy: boolean; error?: never; deletion?: never }
  | { kind: "deletingPhase"; busy: boolean; deletion: WorkspaceDeletionState; error?: never };
export type WorkspaceDeletionState = Static<typeof workspaceDeletionStateSchema>;
export type WorkspaceIssueKind = "readiness" | "image" | "naming";
export interface WorkspaceIssue { kind: WorkspaceIssueKind; message: string }
export interface WorkspaceEntry {
  id: string;
  title: string | null;
  phase: WorkspacePhase;
  requestingAttention: boolean;
  attentionAt?: number;
  lastActivityAt: number;
  init: WorkspaceInitInstruction | undefined;
  parked: boolean;
  imageOutdated: boolean;
  issues?: WorkspaceIssue[];
}
export interface SurfaceState { requestingAttention: boolean; attentionSequence?: number }
export interface AgentState extends SurfaceState { busy: boolean }
export interface WorkspaceRegistryCallbacks {
  rowChanged?(entry: WorkspaceEntry, context: { viewKey?: string; phaseChanged?: boolean; issuesChanged?: boolean }): void;
  parkedChanged?(entry: WorkspaceEntry): void;
  listChanged?(): void;
  removed?(id: string): void;
}
const workspaceTimestampsSchema = Type.Record(Type.String(), Type.Number());
const occurrenceSchema = Type.Object({ sequence: Type.Integer({ minimum: 1 }) });
const workspaceAttentionSchema = Type.Object({
  nextSequence: Type.Integer({ minimum: 1 }),
  workspaces: Type.Record(Type.String(), Type.Number()),
  surfaces: Type.Record(Type.String(), Type.Record(Type.String(), occurrenceSchema)),
});
const workspaceDeletionStateSchema = Type.Intersect([Type.Object({ provisioningError: Type.Optional(Type.String()) }), Type.Union([
  Type.Object({ status: Type.Literal("checking") }),
  Type.Object({ status: Type.Literal("blocked"), fingerprint: Type.String() }),
  Type.Object({ status: Type.Literal("deleting"), forced: Type.Boolean() }),
  Type.Object({ status: Type.Literal("failed"), operation: Type.Literal("checking"), error: Type.String() }),
  Type.Object({ status: Type.Literal("failed"), operation: Type.Literal("deleting"), forced: Type.Boolean(), error: Type.String() }),
])]);
const workspaceDeletionsSchema = Type.Record(Type.String(), workspaceDeletionStateSchema);
export type WorkspaceActivityStore = FileValueStore<Static<typeof workspaceTimestampsSchema>>;
export type WorkspaceAttentionSnapshot = Static<typeof workspaceAttentionSchema>;
export type WorkspaceAttentionStore = FileValueStore<WorkspaceAttentionSnapshot>;
export type WorkspaceDeletionStore = FileValueStore<Static<typeof workspaceDeletionsSchema>>;
export interface WorkspaceRegistryOptions {
  activityStore?: WorkspaceActivityStore;
  attentionStore?: WorkspaceAttentionStore;
  deletionStore?: WorkspaceDeletionStore;
  now?(): number;
}

interface FileValueStore<T> {
  load(): Promise<T>;
  /** Captures the values at invocation; later mutations cannot change the queued write. */
  save(values: T): Promise<void>;
}

function createFileValueStore<Schema extends TSchema>(path: string, schema: Schema, empty: () => Static<Schema>): FileValueStore<Static<Schema>> {
  let saveChain = Promise.resolve();
  return {
    async load() {
      try {
        return Value.Parse(schema, JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if (isNotFoundError(error)) return empty();
        throw error;
      }
    },
    save(values) {
      const snapshot = `${JSON.stringify(values, null, 2)}\n`;
      const nextSave = saveChain.catch(() => undefined).then(() => writeFileAtomic(path, snapshot));
      saveChain = nextSave;
      return nextSave;
    },
  };
}

export function createFileWorkspaceActivityStore(path: string): WorkspaceActivityStore {
  return createFileValueStore(path, workspaceTimestampsSchema, () => ({}));
}

export function createFileWorkspaceAttentionStore(path: string): WorkspaceAttentionStore {
  return createFileValueStore(path, workspaceAttentionSchema, () => ({ nextSequence: 1, workspaces: {}, surfaces: {} }));
}

export function createFileWorkspaceDeletionStore(path: string): WorkspaceDeletionStore {
  return createFileValueStore(path, workspaceDeletionsSchema, () => ({}));
}

export interface WorkspaceRegistry {
  setCallbacks(callbacks: WorkspaceRegistryCallbacks): void;
  seed(workspaces: Array<{ id: string; title: string | null; parked?: boolean; init?: WorkspaceInitInstruction; imageOutdated?: boolean; provisioning?: boolean }>): Promise<void>;
  list(): WorkspaceEntry[];
  get(id: string): WorkspaceEntry | undefined;
  add(id: string, title?: string | null, init?: WorkspaceInitInstruction): WorkspaceEntry;
  startProvisioning(id: string): void;
  setProvisioningState(id: string, status: "working" | "waiting" | "failed", error?: string): void;
  startRunning(id: string): void;
  setDeletion(id: string, deletion: WorkspaceDeletionState): void;
  cancelDeletion(id: string): void;
  setIssue(id: string, kind: WorkspaceIssueKind, message?: string): void;
  setImageOutdated(id: string, outdated: boolean): void;
  setTitle(id: string, title: string | null): void;
  setParked(id: string, parked: boolean): void;
  touch(id: string): void;
  remove(id: string): void;
  setAgentBusy(id: string, agentKey: string, busy: boolean): void;
  requestSurfaceAttention(id: string, surfaceKey: string): void;
  requestAttention(id: string): void;
  clearSurfaceAttention(id: string, surfaceKey: string): void;
  surfaceState(id: string, surfaceKey: string): SurfaceState;
  agentState(id: string, agentKey: string): AgentState;
  setVisibility(connectionId: string, visibility: WorkspaceVisibilityReport): void;
  disconnect(connectionId: string): void;
  oldestAttentionWorkspace(): WorkspaceEntry | undefined;
  busyAgents(id: string): string[];
}

export function createWorkspaceRegistry(options: WorkspaceRegistryOptions = {}): WorkspaceRegistry {
  const now = options.now ?? Date.now;
  const entries = new Map<string, WorkspaceEntry>();
  const busyAgents = new Map<string, Set<string>>();
  const visibility = new Map<string, WorkspaceVisibilityReport>();
  let attention: WorkspaceAttentionSnapshot = { nextSequence: 1, workspaces: {}, surfaces: {} };
  let deletions: Record<string, WorkspaceDeletionState> = {};
  let activity: Record<string, number> = {};
  let callbacks: WorkspaceRegistryCallbacks = {};
  function requireEntry(id: string): WorkspaceEntry {
    const entry = entries.get(id);
    if (!entry) throw new Error(`workspace not in registry: ${id}`);
    return entry;
  }
  function sorted(): WorkspaceEntry[] {
    return [...entries.values()].sort((a, b) => Number(a.parked) - Number(b.parked)
      || Number(b.requestingAttention) - Number(a.requestingAttention)
      || (!a.parked && !a.requestingAttention ? Number(a.phase.busy) - Number(b.phase.busy) : 0)
      || (a.requestingAttention && b.requestingAttention ? a.attentionAt! - b.attentionAt! : b.lastActivityAt - a.lastActivityAt)
      || a.id.localeCompare(b.id));
  }
  function persistAttention(): void { void options.attentionStore?.save(attention).catch((error) => console.error("could not persist workspace attention", error)); }
  function persistActivity(): void { void options.activityStore?.save(activity).catch((error) => console.error("could not persist workspace activity", error)); }
  function persistDeletions(): void { void options.deletionStore?.save(deletions).catch((error) => console.error("could not persist workspace deletion", error)); }
  function visible(id: string, surfaceKey?: string): boolean {
    return [...visibility.values()].some((value) => value.workspaceId === id && (surfaceKey === undefined || value.surfaceKeys.includes(surfaceKey)));
  }
  function unpark(entry: WorkspaceEntry): void {
    if (!entry.parked) return;
    entry.parked = false;
    callbacks.parkedChanged?.(entry);
  }
  function requestAttention(id: string): void {
    const entry = requireEntry(id);
    if (entry.phase.deletion?.status === "deleting") return;
    if (visible(id) || entry.requestingAttention) return;
    unpark(entry);
    entry.requestingAttention = true;
    entry.attentionAt = now();
    attention.workspaces[id] = entry.attentionAt;
    persistAttention();
    callbacks.rowChanged?.(entry, {});
  }
  function changePhase(entry: WorkspaceEntry, phase: WorkspacePhase): void {
    entry.phase = phase;
    callbacks.rowChanged?.(entry, { phaseChanged: true });
  }
  function surfaceState(id: string, key: string): SurfaceState {
    const occurrence = attention.surfaces[id]?.[key];
    return { requestingAttention: occurrence !== undefined, attentionSequence: occurrence?.sequence };
  }
  function clearSurfaceAttention(id: string, key: string): void {
    if (!attention.surfaces[id]?.[key]) return;
    delete attention.surfaces[id]![key];
    persistAttention();
    callbacks.rowChanged?.(requireEntry(id), { viewKey: key });
  }
  return {
    setCallbacks(next) { callbacks = next; },
    async seed(workspaces) {
      activity = await options.activityStore?.load() ?? {};
      attention = await options.attentionStore?.load() ?? attention;
      deletions = await options.deletionStore?.load() ?? {};
      const ids = new Set(workspaces.map((workspace) => workspace.id));
      for (const values of [activity, attention.workspaces, attention.surfaces, deletions]) {
        for (const id of Object.keys(values)) if (!ids.has(id)) delete values[id];
      }
      entries.clear();
      for (const workspace of workspaces) {
        const persisted = deletions[workspace.id];
        const deletion = persisted?.status === "blocked" ? { status: "checking" as const, provisioningError: persisted.provisioningError } : persisted;
        if (deletion) deletions[workspace.id] = deletion;
        const phase: WorkspacePhase = deletion
          ? { kind: "deletingPhase", deletion, busy: deletion.status === "checking" || deletion.status === "deleting" }
          : workspace.provisioning ? { kind: "provisioningPhase", status: "working", busy: true } : { kind: "runningPhase", busy: false };
        const attentionAt = attention.workspaces[workspace.id];
        entries.set(workspace.id, { id: workspace.id, title: workspace.title, init: workspace.init, phase,
          requestingAttention: attentionAt !== undefined, attentionAt, lastActivityAt: activity[workspace.id] ?? 0,
          parked: workspace.parked ?? false, imageOutdated: workspace.imageOutdated ?? false });
      }
      persistActivity(); persistAttention(); persistDeletions();
      callbacks.listChanged?.();
    },
    list: sorted,
    get(id) { return entries.get(id); },
    add(id, title = null, init) {
      if (entries.has(id)) throw new Error(`workspace already in registry: ${id}`);
      const entry: WorkspaceEntry = { id, title, init, phase: { kind: "provisioningPhase", status: "working", busy: true }, requestingAttention: false, lastActivityAt: now(), parked: false, imageOutdated: false };
      entries.set(id, entry); activity[id] = entry.lastActivityAt; persistActivity();
      callbacks.listChanged?.();
      return entry;
    },
    startProvisioning(id) {
      const entry = requireEntry(id);
      if (entry.phase.kind === "deletingPhase") throw new Error("Cannot provision a deleting workspace");
      changePhase(entry, { kind: "provisioningPhase", status: "working", busy: true });
    },
    setProvisioningState(id, status, error) {
      const entry = requireEntry(id);
      if (entry.phase.kind !== "provisioningPhase") throw new Error("Workspace is not provisioning");
      if (entry.phase.status === status && entry.phase.error === error) return;
      changePhase(entry, { kind: "provisioningPhase", status, busy: status === "working", error });
      if (status !== "working") requestAttention(id);
    },
    startRunning(id) {
      const entry = requireEntry(id);
      if (entry.phase.kind === "deletingPhase") throw new Error("Cannot run a deleting workspace");
      changePhase(entry, { kind: "runningPhase", busy: (busyAgents.get(id)?.size ?? 0) > 0 });
    },
    setDeletion(id, deletion) {
      const entry = requireEntry(id);
      const provisioningError = entry.phase.kind === "provisioningPhase"
        ? entry.phase.error ?? "Workspace preparation was cancelled. Delete this workspace or restart AgentsInTheCloud to retry startup."
        : entry.phase.deletion?.provisioningError;
      deletion = { ...deletion, provisioningError };
      deletions[id] = deletion;
      persistDeletions();
      changePhase(entry, { kind: "deletingPhase", deletion, busy: deletion.status === "checking" || deletion.status === "deleting" });
      if (deletion.status === "blocked" || deletion.status === "failed") requestAttention(id);
    },
    cancelDeletion(id) {
      const entry = requireEntry(id);
      if (entry.phase.kind !== "deletingPhase") throw new Error("Workspace is not deleting");
      const provisioningError = entry.phase.deletion.provisioningError;
      delete deletions[id];
      persistDeletions();
      changePhase(entry, provisioningError
        ? { kind: "provisioningPhase", status: "failed", busy: false, error: provisioningError }
        : { kind: "runningPhase", busy: (busyAgents.get(id)?.size ?? 0) > 0 });
      if (provisioningError) requestAttention(id);
    },
    setIssue(id, kind, message) {
      const entry = requireEntry(id);
      const issues = (entry.issues ?? []).filter((issue) => issue.kind !== kind);
      if (message !== undefined) issues.push({ kind, message });
      entry.issues = issues.length ? issues : undefined;
      callbacks.rowChanged?.(entry, { issuesChanged: true });
    },
    setImageOutdated(id, outdated) { const entry = requireEntry(id); entry.imageOutdated = outdated; callbacks.rowChanged?.(entry, { issuesChanged: true }); },
    setTitle(id, title) {
      const entry = requireEntry(id); if (entry.title === title) return;
      entry.title = title;
      // A failed naming attempt stops mattering once the workspace has a name.
      const issues = title ? entry.issues?.filter((issue) => issue.kind !== "naming") : entry.issues;
      const issuesChanged = issues?.length !== entry.issues?.length;
      entry.issues = issues?.length ? issues : undefined;
      callbacks.rowChanged?.(entry, { issuesChanged });
    },
    setParked(id, parked) {
      const entry = requireEntry(id); if (entry.parked === parked) return;
      entry.parked = parked; callbacks.parkedChanged?.(entry); callbacks.rowChanged?.(entry, {});
    },
    touch(id) { const entry = requireEntry(id); entry.lastActivityAt = now(); activity[id] = entry.lastActivityAt; persistActivity(); callbacks.rowChanged?.(entry, {}); },
    remove(id) {
      if (!entries.delete(id)) return;
      busyAgents.delete(id); delete activity[id]; delete attention.workspaces[id]; delete attention.surfaces[id]; delete deletions[id];
      persistActivity(); persistAttention(); persistDeletions(); callbacks.removed?.(id); callbacks.listChanged?.();
    },
    setAgentBusy(id, key, busy) {
      if (!key.startsWith("agent:")) throw new Error(`Not an agent: ${key}`);
      const entry = requireEntry(id);
      const agents = busyAgents.get(id) ?? new Set<string>();
      if (agents.has(key) === busy) return;
      if (busy) agents.add(key); else agents.delete(key);
      busyAgents.set(id, agents);
      if (entry.phase.kind === "runningPhase") entry.phase.busy = agents.size > 0;
      if (busy) unpark(entry);
      callbacks.rowChanged?.(entry, { viewKey: key });
    },
    requestSurfaceAttention(id, key) {
      const entry = requireEntry(id);
      if (visible(id, key) || attention.surfaces[id]?.[key]) return;
      unpark(entry);
      (attention.surfaces[id] ??= {})[key] = { sequence: attention.nextSequence++ };
      persistAttention();
      callbacks.rowChanged?.(entry, { viewKey: key });
    },
    requestAttention,
    clearSurfaceAttention,
    surfaceState,
    agentState(id, key) { return { ...surfaceState(id, key), busy: busyAgents.get(id)?.has(key) ?? false }; },
    setVisibility(connectionId, state) {
      if (state.workspaceId !== undefined) requireEntry(state.workspaceId);
      visibility.set(connectionId, state);
      if (state.workspaceId === undefined) return;
      const entry = requireEntry(state.workspaceId);
      if (entry.requestingAttention) {
        entry.requestingAttention = false; delete entry.attentionAt; delete attention.workspaces[entry.id];
        persistAttention(); callbacks.rowChanged?.(entry, {});
      }
      for (const key of state.surfaceKeys) clearSurfaceAttention(entry.id, key);
    },
    disconnect(connectionId) { visibility.delete(connectionId); },
    oldestAttentionWorkspace() { return sorted().find((entry) => entry.requestingAttention); },
    busyAgents(id) { return [...(busyAgents.get(id) ?? [])]; },
  };
}
