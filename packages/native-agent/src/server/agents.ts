import { AgentsInTheCloudCoreError, createKeyedOperationQueue, type AgentsInTheCloudEventBus, type JsonValue } from "@agents-in-the-cloud/core";
import { createWorkspaceMetadataState } from "@agents-in-the-cloud/workspace";
import { revokeAgentMcp } from "@agents-in-the-cloud/agent/server";
import { suggestAgentSlug } from "@agents-in-the-cloud/agent/server/slug-suggestion";
import { workspaceFollowsAgentTitle } from "@agents-in-the-cloud/agent/server/agent-name-command";
import { parseModelRef } from "@agents-in-the-cloud/llm/server";
import type { createLivePresentation, WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import type { CliModelSettings, createCliModelSettings } from "@agents-in-the-cloud/cli-agent/server";

export interface NativeAgentRecord { id: string; title: string; model?: string; thinkingLevel?: string }

export interface NativeAgentRuntime {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly record: NativeAgentRecord;
  readonly state: { readonly notices: readonly string[] };
  readonly failure?: Error;
  readonly isBusy: boolean;
  readonly isTurnRunning: boolean;
  systemPrompt(): Promise<string>;
  readonly completionCatalog: string;
  readonly promptSuggestion?: string;
  readonly presentation: ReturnType<typeof createLivePresentation>;
  refreshCompletionCatalog(): Promise<void>;
  reconnect(): Promise<void>;
  send(input: WorkspaceAgentInput, requestId: string): Promise<void>;
  stop(): Promise<void>;
  configure(parameters: { model?: string; thinkingLevel?: string }): Promise<void>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export function createNativeAgentStore<Record extends NativeAgentRecord>(filename: string, label: string, parse: (value: JsonValue) => Record[]) {
  const metadata = createWorkspaceMetadataState(filename, value => ({ agents: parse(value) }), () => ({ agents: [] }));
  const list = (workspaceId: string) => metadata.read(workspaceId).agents;
  return {
    label,
    list,
    get(workspaceId: string, id: string) {
      const record = list(workspaceId).find(record => record.id === id);
      if (!record) throw new AgentsInTheCloudCoreError("agent_not_found", `${label} Agent not found: ${id}`);
      return record;
    },
    save(workspaceId: string) { metadata.write(workspaceId, { agents: list(workspaceId) }); },
    add(workspaceId: string, record: Record) { metadata.write(workspaceId, { agents: [...list(workspaceId), record] }); },
    remove(workspaceId: string, id: string) { metadata.write(workspaceId, { agents: list(workspaceId).filter(record => record.id !== id) }); },
  };
}
export type NativeAgentStore<Record extends NativeAgentRecord> = ReturnType<typeof createNativeAgentStore<Record>>;

export function createNativeAgents<Record extends NativeAgentRecord, Runtime extends NativeAgentRuntime>(options: {
  store: () => NativeAgentStore<Record>;
  settings: Pick<ReturnType<typeof createCliModelSettings>, "prepare">;
  newRecord(selected: CliModelSettings): Record;
  open(workspaceId: string, record: Record, save: () => void, events: AgentsInTheCloudEventBus): Promise<Runtime>;
  activate?(runtime: Runtime): Promise<void>;
}, getEvents: () => AgentsInTheCloudEventBus) {
  let metadata: NativeAgentStore<Record> | undefined;
  const store = () => metadata ??= options.store();
  const runtimes = new Map<string, Promise<Runtime>>();
  const serialize = createKeyedOperationQueue();
  async function ready(workspaceId: string, agentId: string) {
    const record = store().get(workspaceId, agentId);
    let runtime = runtimes.get(agentId);
    if (!runtime) {
      runtime = options.open(workspaceId, record, () => store().save(workspaceId), getEvents());
      runtimes.set(agentId, runtime);
      void runtime.catch(() => { if (runtimes.get(agentId) === runtime) runtimes.delete(agentId); });
    }
    const opened = await runtime;
    if (opened.failure) await opened.reconnect();
    return opened;
  }
  async function create(workspaceId: string, parameters: { model?: string; thinkingLevel?: string; input?: WorkspaceAgentInput } = {}) {
    return serialize(workspaceId, async () => {
      const record = options.newRecord(await options.settings.prepare({ model: parameters.model ?? "", thinkingLevel: parameters.thinkingLevel ?? "" }));
      store().add(workspaceId, record);
      const runtime = await ready(workspaceId, record.id);
      await options.activate?.(runtime);
      const input = parameters.input;
      if (input && (input.text.trim() || input.images.length || input.attachmentNotes.length)) {
        await runtime.send(input, `launch-${record.id}`);
        void nameFromPrompts(runtime, input.text).catch(error => console.error(`Could not name ${record.id}`, error));
      }
      return record.id;
    });
  }
  async function close(workspaceId: string, agentId: string) {
    return serialize(workspaceId, async () => {
      store().get(workspaceId, agentId);
      const runtime = runtimes.get(agentId);
      if (runtime) await (await runtime).close();
      runtimes.delete(agentId);
      await revokeAgentMcp(workspaceId, agentId);
      store().remove(workspaceId, agentId);
    });
  }
  async function rename(runtime: Runtime, title: string, onlyIfUntitled = false) {
    const { workspaceId, agentId, record } = runtime;
    const result = await serialize(workspaceId, async () => {
      const previousTitle = record.title;
      if (onlyIfUntitled && previousTitle !== store().label) return undefined;
      record.title = title;
      store().save(workspaceId);
      return { workspaceNamed: await workspaceFollowsAgentTitle(workspaceId, previousTitle, title) };
    });
    if (!result) return;
    await getEvents().emit("workspace_agent_title_changed", { workspaceId, agentId, title });
    if (result.workspaceNamed) await getEvents().emit("workspace_title_changed", { workspaceId, title });
  }
  function suggestTitle(runtime: Runtime, prompts: string) {
    return suggestAgentSlug(prompts, runtime.record.model ? parseModelRef(runtime.record.model) : undefined);
  }
  const naming = new Set<string>();
  async function nameFromPrompts(runtime: Runtime, prompts: string) {
    if (!prompts.trim() || runtime.record.title !== store().label || naming.has(runtime.agentId)) return;
    naming.add(runtime.agentId);
    try {
      const title = await suggestTitle(runtime, prompts);
      if (title) await rename(runtime, title, true);
    } finally { naming.delete(runtime.agentId); }
  }
  async function disposeWorkspace(workspaceId: string) {
    for (const record of store().list(workspaceId)) {
      const runtime = runtimes.get(record.id);
      if (runtime) { await (await runtime).dispose(); runtimes.delete(record.id); }
      await revokeAgentMcp(workspaceId, record.id);
    }
  }
  async function disposeAll() {
    await Promise.all([...runtimes.values()].map(async runtime => (await runtime).dispose()));
    runtimes.clear();
  }
  return { list: (workspaceId: string) => store().list(workspaceId), ready, create, rename, suggestTitle, nameFromPrompts, close, disposeWorkspace, disposeAll };
}
export type NativeAgents<Runtime extends NativeAgentRuntime> = ReturnType<typeof createNativeAgents<NativeAgentRecord, Runtime>>;
