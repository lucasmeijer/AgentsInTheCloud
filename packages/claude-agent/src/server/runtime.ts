import { createHash } from "node:crypto";
import type { EffortLevel, ModelInfo, Query, SDKMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createKeyedOperationQueue, invalidArguments, type AgentsInTheCloudEventBus, type JsonValue } from "@agents-in-the-cloud/core";
import { createLivePresentation, type WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { createPiModelRuntime, parseModelRef, setAgentModelPreference } from "@agents-in-the-cloud/llm/server";
import { publishWorkspaceAgentBusy } from "@agents-in-the-cloud/agent/server";
import { readPromptSuggestionsEnabled } from "@agents-in-the-cloud/agent/server/prompt-suggestions";
import { createNativeAgents } from "@agents-in-the-cloud/native-agent/server";
import { listPromptOnlyTemplates } from "@agents-in-the-cloud/agent/server/prompt-templates";
import { renderSlashCommandCatalog } from "@agents-in-the-cloud/agent/server/slash-commands";
import { claudeAgentCommands, claudeNativeCommands, uuidPattern, type ClaudeCommand, type ClaudeCommandResult } from "./commands.ts";
import { claudeSessionDirectory, hasClaudeSession, listClaudeSessions, readClaudeRows, type ClaudeBlock } from "./rows.ts";
import { workflowProgress, workflowProgressSchema, type ClaudeWorkflowProgress } from "./workflow.ts";
import { ClaudeState } from "./state.ts";
import { openClaudeTransport, type ClaudeTransport } from "./transport.ts";
import { agentTypeId, label, prepareClaude, settings } from "./setup.ts";
import { createClaudeStore, type ClaudeAgentRecord } from "./store.ts";
import { liveRegions } from "./render.ts";

export interface ClaudeTask {
  id: string;
  type: string;
  description: string;
  subagentType?: string;
  parentTaskId?: string;
  ambient: boolean;
  toolUseId?: string;
  startedAt?: number;
  workflowName?: string;
  script?: string;
  summary?: string;
  lastToolName?: string;
  usage?: { tokens: number; toolUses: number };
  workflow?: ClaudeWorkflowProgress;
}

const taskOutputSchema = Type.Object({ output: Type.String(), total_bytes: Type.Number(), truncated: Type.Boolean() });

function promptUuid(requestId: string): string {
  if (uuidPattern.test(requestId)) return requestId.toLowerCase();
  const hex = createHash("sha256").update(requestId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class ClaudeRuntime {
  readonly state = new ClaudeState();
  instructions = "";
  models: ModelInfo[] = [];
  private commands: SlashCommand[] = [];
  private templateNames = new Set<string>();
  completionCatalog = "";
  failure?: Error;
  promptSuggestion?: string;
  contextPercent: number | null = null;
  private transport?: ClaudeTransport;
  private connecting?: Promise<void>;
  private disposed = false;
  private closing = false;
  private running = false;
  tasks: ClaudeTask[] = [];
  private taskEvents = new Map<string, Partial<ClaudeTask>>();
  private interrupting = false;
  private busy = false;
  private readonly serialize = createKeyedOperationQueue();
  readonly presentation = createLivePresentation(() => liveRegions(this), 50);
  private constructor(readonly workspaceId: string, readonly record: ClaudeAgentRecord, private readonly save: () => void, private readonly events: AgentsInTheCloudEventBus) {}
  get agentId() { return this.record.id; }
  get isTurnRunning() { return !this.failure && this.running; }
  get isBusy() { return !this.failure && (this.running || this.reportedTasks.length > 0); }
  private get reportedTasks() { return this.tasks.filter(task => !task.ambient); }
  private changed() {
    if (this.disposed) return;
    if (this.running) this.promptSuggestion = undefined;
    const busy = this.isBusy;
    if (busy !== this.busy) {
      this.busy = busy;
      publishWorkspaceAgentBusy({ workspaceId: this.workspaceId, agentKey: `agent:${this.agentId}`, busy });
      if (!busy) {
        void this.events.emit("workspace_agent_turn_finished", { workspaceId: this.workspaceId, agentId: this.agentId }).catch(error => console.error("Could not publish Claude Code turn completion", error));
        void this.refreshCompletionCatalog().catch(error => console.error("Could not refresh Claude Code completions", error));
      }
    }
    this.presentation.invalidate();
  }
  async refreshCompletionCatalog() {
    const templates = await listPromptOnlyTemplates(this.workspaceId);
    this.templateNames = new Set(templates.map(template => template.name));
    this.completionCatalog = renderSlashCommandCatalog(templates, [], "cli", [...claudeAgentCommands, ...claudeNativeCommands(this.commands, this.templateNames)]);
    this.presentation.invalidate();
  }
  isClaudeCommand(text: string) {
    const name = text.trim().match(/^\/(\S+)/)?.[1];
    return Boolean(name && !this.templateNames.has(name) && this.commands.some(command => command.name === name || command.aliases?.includes(name)));
  }
  static async open(workspaceId: string, record: ClaudeAgentRecord, save: () => void, events: AgentsInTheCloudEventBus) {
    const runtime = new ClaudeRuntime(workspaceId, record, save, events);
    try {
      await runtime.prepareState();
      void runtime.startConnection(true).catch(() => {});
      return runtime;
    }
    catch (error) { await runtime.dispose(); throw error; }
  }
  async systemPrompt() {
    await this.activate();
    return this.instructions;
  }
  async activate() {
    if (this.connecting) await this.connecting;
    if (this.failure) await this.reconnect();
    if (!this.transport) throw new Error("Claude Code Agent is not connected");
  }
  async reconnect() {
    if (this.connecting) return this.connecting;
    return this.serialize(this.agentId, async () => {
      if (!this.failure) return;
      if (this.disposed || this.closing) throw new Error("Claude Code Agent is closed");
      await this.transport?.close();
      this.failure = undefined;
      await this.startConnection();
    });
  }
  get sessions() { return claudeSessionDirectory(this.workspaceId, this.agentId); }
  private async prepareState() {
    const { sessionId, forkedFrom } = this.record;
    const exists = await hasClaudeSession(this.sessions, sessionId);
    if (exists && forkedFrom) { delete this.record.forkedFrom; this.save(); }
    const source = exists ? sessionId : forkedFrom;
    this.state.hydrate(source ? await readClaudeRows(this.sessions, source) ?? [] : []);
  }
  private startConnection(statePrepared = false): Promise<void> {
    if (this.connecting) return this.connecting;
    const connection = this.connect(statePrepared);
    this.connecting = connection;
    void connection.then(
      () => { if (this.connecting === connection) this.connecting = undefined; },
      () => { if (this.connecting === connection) this.connecting = undefined; },
    );
    return connection;
  }
  private async connect(statePrepared = false) {
    this.running = false;
    this.tasks = [];
    this.taskEvents.clear();
    this.interrupting = false;
    this.promptSuggestion = undefined;
    try {
      if (!statePrepared) await this.prepareState();
      this.instructions = (await prepareClaude(this.workspaceId, this.agentId)).instructions;
      const { sessionId, forkedFrom } = this.record;
      const exists = await hasClaudeSession(this.sessions, sessionId);
      this.transport = await openClaudeTransport(this.workspaceId, this.agentId, {
        sessionId, ...exists ? { resume: sessionId } : forkedFrom ? { resume: forkedFrom, forkSession: true } : {},
        instructions: this.instructions,
        model: this.record.model ? parseModelRef(this.record.model)!.id : undefined,
        // SAFETY: The launch picker or Claude's catalog validated the stored effort.
        effort: this.record.thinkingLevel as EffortLevel | undefined,
      }, message => this.receive(message), error => { this.failure = error; this.changed(); });
      const initialized = await this.transport.query.initializationResult();
      if (this.disposed || this.closing) { await this.transport.close(); return; }
      const registry = await createPiModelRuntime();
      this.models = initialized.models.map(model => model.value === "default" ? model : { ...model, displayName: registry.getModel("anthropic", model.resolvedModel ?? model.value)?.name ?? model.displayName });
      this.commands = initialized.commands;
      await this.refreshContextUsage();
      this.changed();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.changed();
      await this.transport?.close();
      throw error;
    }
  }
  async send(input: WorkspaceAgentInput, requestId: string) {
    await this.activate();
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      const text = [input.text, ...input.attachmentNotes].filter(Boolean).join("\n\n");
      const content: ClaudeBlock[] = [...text ? [{ type: "text", text }] : [], ...input.images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))];
      const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      if (this.record.commandSubmissions?.some(entry => entry.id === requestId)) throw invalidArguments("This request ID was already used for a command");
      const previous = this.record.submissions.find(entry => entry.id === requestId);
      if (previous) {
        if (previous.digest !== digest) throw invalidArguments("This request ID was already used for a different prompt");
        return;
      }
      this.record.submissions.push({ id: requestId, digest });
      this.save();
      const uuid = promptUuid(requestId);
      this.state.add(this.running ? { kind: "steer", uuid, timestamp: Date.now(), content } : { kind: "user", uuid, timestamp: Date.now(), content, meta: false });
      this.running = true;
      // SAFETY: Content blocks match the API's text and base64 image parameters.
      this.transport!.send({ type: "user", uuid: uuid as `${string}-${string}-${string}-${string}-${string}`, session_id: "", parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: content as never } });
      this.changed();
    });
  }
  async command(command: ClaudeCommand, requestId: string): Promise<ClaudeCommandResult> {
    await this.activate();
    if (command.kind === "model") {
      await this.configure({ model: `anthropic::${command.model}` });
      return { kind: "done", message: `Using ${this.selectedModel?.displayName ?? command.model}.` };
    }
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      if (command.kind === "resume" && !command.sessionId) {
        this.requireIdle("switching conversations");
        return { kind: "resume", sessions: await listClaudeSessions(this.sessions, 50), current: this.record.sessionId };
      }
      if (this.record.submissions.some(entry => entry.id === requestId)) throw invalidArguments("This request ID was already used for a prompt");
      const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      const previous = this.record.commandSubmissions?.find(entry => entry.id === requestId);
      if (previous) {
        if (previous.digest !== digest) throw invalidArguments("This request ID was already used for a different command");
        return { kind: "done", message: previous.message };
      }
      const switched = (message: string) => ({ id: requestId, digest, message });
      switch (command.kind) {
        case "new":
          this.requireIdle("starting a fresh conversation");
          return this.switchSession({ sessionId: crypto.randomUUID() }, switched("New Claude Code conversation started."));
        case "fork": {
          this.requireIdle("forking the conversation");
          if (!await hasClaudeSession(this.sessions, this.record.sessionId)) throw invalidArguments("Send a prompt before forking the conversation");
          const result = await this.switchSession({ sessionId: crypto.randomUUID(), forkedFrom: this.record.sessionId }, switched("Conversation forked."));
          this.state.notices.push("Continuing in a fork. The original conversation is available through /resume.");
          this.changed();
          return result;
        }
        case "resume": {
          this.requireIdle("switching conversations");
          const { sessionId } = command;
          if (!sessionId || !await hasClaudeSession(this.sessions, sessionId)) throw invalidArguments("Choose a saved Claude Code conversation");
          return this.switchSession({ sessionId }, switched("Conversation resumed."));
        }
      }
    });
  }
  private async switchSession(session: { sessionId: string; forkedFrom?: string }, submission: NonNullable<ClaudeAgentRecord["commandSubmissions"]>[number]): Promise<ClaudeCommandResult> {
    await this.transport?.close();
    this.record.sessionId = session.sessionId;
    if (session.forkedFrom) this.record.forkedFrom = session.forkedFrom; else delete this.record.forkedFrom;
    (this.record.commandSubmissions ??= []).push(submission);
    this.save();
    this.state.notices.length = 0;
    await this.startConnection();
    return { kind: "done", message: submission.message };
  }
  private requireIdle(action: string) {
    if (this.isBusy) throw invalidArguments(`Stop Claude before ${action}`);
  }
  async stop() {
    await this.activate();
    this.assertOpen();
    if (this.running) {
      this.interrupting = true;
      await this.transport!.query.interrupt();
    }
    await Promise.all(this.reportedTasks.map(task => this.transport!.query.stopTask(task.id)));
  }
  async stopTask(taskId: string) {
    await this.activate();
    this.assertOpen();
    await this.transport!.query.stopTask(taskId);
  }
  async taskOutput(taskId: string) {
    await this.activate();
    this.assertOpen();
    // SAFETY: The SDK implements the get_task_output control request, typed as SDKControlGetTaskOutputRequest, but its Query type doesn't declare the method yet. The response is parsed.
    const query = this.transport!.query as Query & { getTaskOutput(taskId: string): Promise<JsonValue> };
    return Value.Parse(taskOutputSchema, await query.getTaskOutput(taskId));
  }
  get selectedModel(): ModelInfo | undefined {
    const id = this.record.model ? parseModelRef(this.record.model)?.id : undefined;
    return id ? this.models.find(model => model.value === id || model.resolvedModel === id) : this.models.find(model => model.value === "default");
  }
  get selection() {
    const selected = this.selectedModel;
    return {
      models: this.models.map(model => ({ provider: "anthropic", id: model.value, name: model.displayName, selected: model === selected, available: true })),
      thinkingLevels: selected?.supportedEffortLevels ?? [],
    };
  }
  async configure(parameters: { model?: string; thinkingLevel?: string }) {
    await this.activate();
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      if (this.isTurnRunning) throw invalidArguments("Stop Claude before changing its model or thinking level");
      const requested = parameters.model ? parseModelRef(parameters.model) : undefined;
      const model = requested ? requested.provider === "anthropic" && this.models.find(model => model.value === requested.id || model.resolvedModel === requested.id) : this.selectedModel;
      if (!model) throw invalidArguments("Choose an available Claude Code model");
      const levels = model.supportedEffortLevels ?? [];
      const current = parameters.thinkingLevel ?? this.record.thinkingLevel;
      const effort = levels.find(level => level === current) ?? (parameters.thinkingLevel ? undefined : levels.find(level => level === "medium") ?? levels[0]);
      if (parameters.thinkingLevel && !effort) throw invalidArguments("Unsupported Claude Code thinking level");
      const query = this.transport!.query;
      if (requested) await query.setModel(model.value === "default" ? undefined : model.value);
      if (effort) await query.applyFlagSettings({ effortLevel: effort });
      const id = model.resolvedModel ?? model.value;
      if (model.value === "default") delete this.record.model; else this.record.model = `anthropic::${id}`;
      if (effort) this.record.thinkingLevel = effort; else delete this.record.thinkingLevel;
      if (model.value !== "default") await setAgentModelPreference(agentTypeId, { provider: "anthropic", id }, effort);
      this.save();
      await this.refreshContextUsage();
      this.changed();
    });
  }
  async close() {
    this.closing = true;
    await this.serialize(this.agentId, async () => {
      if (this.running && !this.failure) await this.transport!.query.interrupt();
      await this.dispose();
    });
  }
  private receive(message: SDKMessage) {
    if (this.disposed) return;
    if (message.type === "conversation_reset") {
      this.record.sessionId = message.new_conversation_id;
      delete this.record.forkedFrom;
      this.save();
      this.state.hydrate([]);
      this.state.notices.length = 0;
    } else if (message.type === "system" && message.subtype === "commands_changed") {
      this.commands = message.commands;
      void this.refreshCompletionCatalog().catch(error => console.error("Could not refresh Claude Code completions", error));
    } else if (message.type === "system" && message.subtype === "background_tasks_changed") {
      const live = new Set(message.tasks.map(task => task.task_id));
      for (const task of this.tasks) if (!live.has(task.id)) this.taskEvents.delete(task.id);
      this.tasks = message.tasks.map(task => ({
        ...this.taskEvents.get(task.task_id),
        id: task.task_id, type: task.task_type, description: task.description, subagentType: task.subagent_type, parentTaskId: task.parent_task_id, ambient: task.ambient === true,
      }));
    } else if (message.type === "system" && (message.subtype === "task_started" || message.subtype === "task_progress")) {
      const events = this.taskEvents.get(message.task_id) ?? {};
      if (message.subtype === "task_started") Object.assign(events, { toolUseId: message.tool_use_id, startedAt: Date.now(), workflowName: message.workflow_name, script: message.task_type === "local_workflow" ? message.prompt : undefined });
      else {
        Object.assign(events, { summary: message.summary, lastToolName: message.last_tool_name, usage: { tokens: message.usage.total_tokens, toolUses: message.usage.tool_uses } });
        // SAFETY: Claude Code sends a workflow's phases and agents on its task_progress, but the SDK doesn't declare the field yet. It is parsed.
        // A frame without it changed nothing about them.
        const entries = (message as { workflow_progress?: unknown }).workflow_progress;
        if (entries !== undefined) events.workflow = workflowProgress(Value.Parse(workflowProgressSchema, entries));
      }
      this.taskEvents.set(message.task_id, events);
      this.tasks = this.tasks.map(task => task.id === message.task_id ? { ...task, ...events } : task);
    } else if (message.type === "system" && message.subtype === "task_notification" && message.status !== "stopped" && this.reportedTasks.some(task => task.id === message.task_id)) {
      // Claude reports on finished background work in its running turn, or else in a turn of its own.
      // Foreground commands notify too, but were never background work.
      this.state.add({
        kind: "task", uuid: message.uuid, timestamp: Date.now(), runId: message.run_id ?? message.uuid, toolUseId: message.tool_use_id, status: message.status, summary: message.summary,
        usage: message.usage && { tokens: message.usage.total_tokens, toolUses: message.usage.tool_uses, durationMs: message.usage.duration_ms },
      });
      this.running = true;
    } else if (message.type === "result") {
      this.running = (message.queued_turn_count ?? 0) > 0;
      // An interrupted turn reports its abort as an error; the transcript already shows it stopped.
      // Diagnostic lines describe Claude Code's internals, not something to act on.
      const errors = message.subtype === "success" ? [] : message.errors.filter(error => !error.startsWith("[ede_diagnostic]"));
      if (errors.length && !this.interrupting) this.state.notices.push(errors.join("\n"));
      this.interrupting = false;
      void this.refreshHistory().catch(error => console.error("Could not read Claude Code history", error));
      void this.refreshContextUsage().then(() => this.changed()).catch(error => console.error("Could not read Claude Code context usage", error));
    } else if (message.type === "prompt_suggestion") {
      void readPromptSuggestionsEnabled().then(enabled => {
        if (!enabled || this.running) return;
        this.promptSuggestion = message.suggestion;
        this.changed();
      }).catch(error => console.error("Could not read the Suggested prompts setting", error));
    } else if (message.type === "stream_event" || message.type === "assistant") {
      this.running = true;
    }
    if (message.type === "system" && message.subtype === "task_notification" && !this.tasks.some(task => task.id === message.task_id)) this.taskEvents.delete(message.task_id);
    this.state.receive(message);
    this.changed();
  }
  private async refreshContextUsage() {
    this.contextPercent = (await this.transport!.query.getContextUsage({ detail: "summary" })).percentage;
  }
  private async refreshHistory() {
    const sessionId = this.record.sessionId;
    const rows = await readClaudeRows(this.sessions, sessionId);
    if (!rows || sessionId !== this.record.sessionId || this.disposed) return;
    this.state.merge(rows);
    this.changed();
  }
  private assertOpen() { if (this.failure) throw this.failure; if (this.disposed || this.closing) throw new Error("Claude Code Agent is closed"); }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.transport?.close();
    if (this.busy) publishWorkspaceAgentBusy({ workspaceId: this.workspaceId, agentKey: `agent:${this.agentId}`, busy: false });
    this.presentation.dispose();
  }
}

export function createClaudeAgents(getEvents: () => AgentsInTheCloudEventBus) {
  return createNativeAgents({
    store: createClaudeStore, settings, open: ClaudeRuntime.open,
    activate: runtime => runtime.activate(),
    newRecord: (selected): ClaudeAgentRecord => ({ id: crypto.randomUUID(), title: label, sessionId: crypto.randomUUID(), ...selected, submissions: [] }),
  }, getEvents);
}
