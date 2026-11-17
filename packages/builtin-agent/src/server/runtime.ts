import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { resolveNewWorkspaceAgentModel } from "@agents-in-the-cloud/agent/server/model-state";
import { AgentPresentation } from "./agent-presentation.ts";
import { openDurableAgentRuntime, type DurableAgentRuntime, type DurableAgentController } from "./durable-runtime.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspaceDurableJournalDirectory } from "./durable-storage.ts";
import { listWorkspaceAgents } from "./agent-store.ts";
import type { WorkspaceAgentOptions } from "./runtime-types.ts";
import type { WorkspaceAgentInfo } from "./agent-store.ts";

export type { AgentLivePresentationSubscription } from "./runtime-types.ts";
export { subscribeWorkspaceAgentBusy } from "@agents-in-the-cloud/agent/server";

const presentations = new Map<string, Promise<AgentPresentation>>();
// First attachment can prepare a root before it exists in the catalog. Lifecycle
// fences must join that acquisition even when no presentation was ever mounted.
const controllerAcquisitions = new Map<string, Promise<DurableAgentController>>();
const removedWorkspaceIds = new Set<string>();
const closedAgentKeys = new Set<string>();
const nativeClosedAgentKeys = new Set<string>();
const suspendedWorkspaceIds = new Set<string>();
let stopping = false;
const lifecycle = new Map<string, Promise<void>>();

function lifecycleCommand(workspaceId: string, run: () => Promise<void>): Promise<void> {
  const previous = lifecycle.get(workspaceId) ?? Promise.resolve();
  const result = previous.then(run, run);
  const drain = result.then(() => {}, () => {});
  lifecycle.set(workspaceId, drain);
  void drain.then(() => { if (lifecycle.get(workspaceId) === drain) lifecycle.delete(workspaceId); });
  return result;
}

function runtimeKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}\u0000${agentId}`;
}

export function unloadWorkspaceAgentPresentation(workspaceId: string, agentId: string): Promise<void> {
  return lifecycleCommand(workspaceId, () => unloadRuntime(workspaceId, agentId));
}
async function unloadRuntime(workspaceId: string, agentId: string): Promise<void> {
  const key = runtimeKey(workspaceId, agentId);
  const runtime = presentations.get(key);
  if (!runtime) return;
  presentations.delete(key);
  await (await runtime).dispose();
}

export function restoreWorkspaceAgentRuntime(workspaceId: string, agentId: string): void {
  const key = runtimeKey(workspaceId, agentId);
  if (!nativeClosedAgentKeys.has(key)) closedAgentKeys.delete(key);
}

export function removeWorkspaceAgentRuntimes(workspaceId: string): Promise<void> {
  removedWorkspaceIds.add(workspaceId);
  return lifecycleCommand(workspaceId, () => removeRuntimes(workspaceId));
}
async function removeRuntimes(workspaceId: string): Promise<void> {
  await drainControllerAcquisitions(workspaceId);
  const pending = [...presentations.entries()].filter(([key]) => key.startsWith(`${workspaceId}\u0000`));
  await Promise.allSettled(pending.map(([, runtime]) => runtime));
  const native = existsSync(join(await workspaceDurableJournalDirectory(workspaceId), "main.jsonl"));
  if (native) await (await durableWorkspaceOwner(workspaceId)).delete();
  const matching = [...presentations.entries()].filter(([key]) => key.startsWith(`${workspaceId}\u0000`));
  for (const [key] of matching) presentations.delete(key);
  const settled = await Promise.allSettled(matching.map(([, runtime]) => runtime));
  await Promise.all(settled.flatMap((result) => result.status === "fulfilled" ? [result.value.dispose()] : []));
  await suspendDurableWorkspaceOwner(workspaceId);
}

export function getWorkspaceAgentPresentation(agent: WorkspaceAgentInfo, options: WorkspaceAgentOptions = {}): Promise<AgentPresentation> {
  assertWorkspaceAgentAvailable(agent);
  const key = runtimeKey(agent.workspaceId, agent.agentId);
  const pendingLifecycle = lifecycle.get(agent.workspaceId);
  if (pendingLifecycle) return pendingLifecycle.then(() => getWorkspaceAgentPresentation(agent, options));
  let runtime = presentations.get(key);
  if (!runtime) {
    runtime = (async () => AgentPresentation.create(agent, await (await durableWorkspaceOwner(agent.workspaceId, options)).agent(agent)))().catch((error) => {
      presentations.delete(key);
      throw error;
    });
    presentations.set(key, runtime);
  }
  return runtime;
}

export function closeWorkspaceAgent(workspaceId: string, agentId: string): Promise<void> {
  closedAgentKeys.add(runtimeKey(workspaceId, agentId));
  return lifecycleCommand(workspaceId, () => closeAgent(workspaceId, agentId));
}
async function closeAgent(workspaceId: string, agentId: string): Promise<void> {
  const key = runtimeKey(workspaceId, agentId);
  const pending = presentations.get(key);
  if (pending) await pending;
  await Promise.allSettled([controllerAcquisitions.get(key)]);
  const agent = (await listWorkspaceAgents(workspaceId)).find(item => item.agentId === agentId);
  if (agent) {
    nativeClosedAgentKeys.add(key);
    await (await existingDurableController(agent))?.close();
  }
  await unloadRuntime(workspaceId, agentId);
}

export function stopDurableWorkspaceAgent(agent: WorkspaceAgentInfo, options: WorkspaceAgentOptions = {}): Promise<void> {
  return lifecycleCommand(agent.workspaceId, async () => {
    await Promise.allSettled([controllerAcquisitions.get(runtimeKey(agent.workspaceId, agent.agentId))]);
    await (await existingDurableController(agent, options))?.stop();
  });
}

export async function refreshConfiguredAgentRuntimes(): Promise<void> {
  const defaultModel = await resolveNewWorkspaceAgentModel();
  await Promise.all([...presentations.values()].map(async (pending) => {
    await (await pending).refreshModelConfiguration(defaultModel);
  }));
}

export async function refreshWorkspaceCompletionCatalogs(workspaceId: string): Promise<void> {
  const matching = [...presentations.entries()].filter(([key]) => key.startsWith(`${workspaceId}\u0000`));
  await Promise.all(matching.map(async ([, pending]) => (await pending).refreshCompletionCatalog()));
}

export function suspendWorkspaceAgentRuntimes(workspaceId: string): Promise<void> {
  suspendedWorkspaceIds.add(workspaceId);
  return lifecycleCommand(workspaceId, () => suspendRuntimes(workspaceId));
}
async function suspendRuntimes(workspaceId: string): Promise<void> {
  await drainControllerAcquisitions(workspaceId);
  const matching = [...presentations.entries()].filter(([key]) => key.startsWith(`${workspaceId}\u0000`));
  for (const [key] of matching) presentations.delete(key);
  for (const [, runtime] of matching) await (await runtime).dispose();
  await suspendDurableWorkspaceOwner(workspaceId);
}

export function allowWorkspaceAgentResume(workspaceId: string): void {
  suspendedWorkspaceIds.delete(workspaceId);
}
export async function stopWorkspaceAgentRuntimes(): Promise<void> {
  stopping = true;
  const workspaces = new Set([
    ...[...presentations.keys(), ...controllerAcquisitions.keys()].map(key => key.split("\u0000")[0]!),
    ...[...owners.values()].map(owner => owner.workspaceId),
  ]);
  for (const workspaceId of workspaces) await suspendWorkspaceAgentRuntimes(workspaceId);
  await suspendAllDurableWorkspaceOwners();
}

function assertWorkspaceAgentAvailable(agent: WorkspaceAgentInfo): void {
  if (stopping || suspendedWorkspaceIds.has(agent.workspaceId)) throw new Error("Workspace agent execution is suspended");
  if (removedWorkspaceIds.has(agent.workspaceId)) throw new AgentsInTheCloudCoreError("workspace_not_found", `workspace not found: ${agent.workspaceId}`);
  if (closedAgentKeys.has(runtimeKey(agent.workspaceId, agent.agentId))) throw new AgentsInTheCloudCoreError("agent_not_found", `Agent not found: ${agent.agentId}`);
}

export function getWorkspaceAgentController(agent: WorkspaceAgentInfo, options: WorkspaceAgentOptions = {}): Promise<DurableAgentController> {
  assertWorkspaceAgentAvailable(agent);
  const pending = lifecycle.get(agent.workspaceId);
  if (pending) return pending.then(() => getWorkspaceAgentController(agent, options));
  const key = runtimeKey(agent.workspaceId, agent.agentId);
  let acquisition = controllerAcquisitions.get(key);
  if (!acquisition) {
    acquisition = (async () => {
      const owner = await durableWorkspaceOwner(agent.workspaceId, options);
      assertWorkspaceAgentAvailable(agent);
      return owner.agent(agent);
    })().finally(() => { controllerAcquisitions.delete(key); });
    controllerAcquisitions.set(key, acquisition);
  }
  return acquisition;
}

async function drainControllerAcquisitions(workspaceId: string): Promise<void> {
  await Promise.allSettled([...controllerAcquisitions].filter(([key]) => key.startsWith(`${workspaceId}\u0000`)).map(([, pending]) => pending));
}

let ownerEvents: WorkspaceAgentOptions["events"];
export function configureDurableOwnerEvents(events: NonNullable<WorkspaceAgentOptions["events"]>) { ownerEvents = events; }

const owners = new Map<string, { workspaceId: string; runtime: Promise<DurableAgentRuntime> }>();
const suspensions = new Map<string, Promise<void>>();
export async function durableWorkspaceOwner(workspaceId: string, options: WorkspaceAgentOptions = {}): Promise<DurableAgentRuntime> {
  return retainedDurableWorkspaceOwner(await workspaceDurableJournalDirectory(workspaceId), workspaceId, options);
}
export function retainedDurableWorkspaceOwner(directory: string, workspaceId: string, options: WorkspaceAgentOptions = {}, load?: Parameters<typeof openDurableAgentRuntime>[3]): Promise<DurableAgentRuntime> {
  const suspension = suspensions.get(workspaceId);
  if (suspension) return suspension.then(() => retainedDurableWorkspaceOwner(directory, workspaceId, options, load));
  let owner = owners.get(directory);
  if (!owner) {
    const runtime = openDurableAgentRuntime(directory, workspaceId, { events: options.events ?? ownerEvents }, load).catch(error => {
      owners.delete(directory);
      throw error;
    });
    owner = { workspaceId, runtime };
    owners.set(directory, owner);
  }
  return owner.runtime;
}
function suspendDurableWorkspaceOwner(workspaceId: string): Promise<void> {
  const pending = suspensions.get(workspaceId);
  if (pending) return pending;
  const selected = [...owners].filter(([, owner]) => owner.workspaceId === workspaceId);
  if (!selected.length) return Promise.resolve();
  const closing = (async () => {
    await Promise.all(selected.map(async ([directory, owner]) => {
      await (await owner.runtime).suspend();
      owners.delete(directory);
    }));
  })().finally(() => { suspensions.delete(workspaceId); });
  suspensions.set(workspaceId, closing);
  return closing;
}
export async function suspendAllDurableWorkspaceOwners() {
  await Promise.all([...new Set([...owners.values()].map(owner => owner.workspaceId))].map(suspendDurableWorkspaceOwner));
}

export async function existingDurableController(agent: WorkspaceAgentInfo, options: WorkspaceAgentOptions = {}) {
  if (!existsSync(join(await workspaceDurableJournalDirectory(agent.workspaceId), "main.jsonl"))) return undefined;
  const owner = await durableWorkspaceOwner(agent.workspaceId, options);
  if (!(await owner.catalog()).some(record => record.agentId === agent.agentId)) return undefined;
  return owner.agent(agent);
}
export async function knownWorkspaceAgentRequest(agent: WorkspaceAgentInfo, requestId: string, options: WorkspaceAgentOptions = {}) {
  return (await existingDurableController(agent, options))?.knownRequest(requestId) ?? false;
}
