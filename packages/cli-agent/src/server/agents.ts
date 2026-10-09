import { agentKey } from "@agents-in-the-cloud/agent/server/render-context";
import { publishWorkspaceAgentBusy, prepareCliAgentConnection, revokeAgentMcp, type AgentTurnFinishReason } from "@agents-in-the-cloud/agent/server";
import { suggestAgentSlug } from "@agents-in-the-cloud/agent/server/slug-suggestion";
import { parseModelRef } from "@agents-in-the-cloud/llm/server";
import { exportCliHistory } from "./history.ts";
import { emptyAgentInput } from "./launch-script.ts";
import { AgentsInTheCloudCoreError, createKeyedOperationQueue, shellQuote } from "@agents-in-the-cloud/core";
import { buildObservableSessionCommand } from "@agents-in-the-cloud/observable-terminal/server";
import { imageMimeByExtension } from "@agents-in-the-cloud/shared/file-metadata";
import { errorMessage, type AgentWorkspaceParameters, type WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { createWorkspaceMetadataState, execWorkspaceShell, getWorkspaceTitle, setWorkspaceTitle, workspaceRoot } from "@agents-in-the-cloud/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { CliAgentAdapter, CliAgentSession } from "./adapter.ts";

const inputSchema = Type.Object({ text: Type.String(), images: Type.Array(Type.Object({ mimeType: Type.String(), data: Type.String() })), attachmentNotes: Type.Array(Type.String()) });
const agentSchema = Type.Object({
  id: Type.String(), title: Type.String(), tmuxSession: Type.String(), input: inputSchema,
  // Older CLI tabs have no kind. Reading them must never execute their saved prompts.
  kind: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()),
  historySlug: Type.Optional(Type.String()),
});
const stateSchema = Type.Object({ agents: Type.Array(agentSchema) });
const previousStateSchema = Type.Object({ sessions: Type.Array(agentSchema) });
type CliAgentRecord = Static<typeof agentSchema>;
const turnSettleTimeoutMs = 10_000;

export async function checkedWorkspaceShell(workspaceId: string, command: string, stdin?: string): Promise<void> {
  const result = await execWorkspaceShell(workspaceId, command, { stdin });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Command failed (exit ${result.exitCode})`);
}

/** Write private session files in one workspace command, keeping contents off its command line. */
export async function writeCliSessionFiles(workspaceId: string, session: CliAgentSession, files: Record<string, string>): Promise<void> {
  const entries = Object.entries(files);
  const commands = entries.map(([name, content], index) => {
    const path = shellQuote(`${session.directory}/${name}`);
    const write = index === entries.length - 1 ? `cat > ${path}` : `dd bs=1 count=${Buffer.byteLength(content)} of=${path} status=none`;
    return `mkdir -p "$(dirname ${path})"\n${write}`;
  });
  await checkedWorkspaceShell(workspaceId, `set -eu\numask 077\n${commands.join("\n")}`, entries.map(([, content]) => content).join(""));
}

export function createCliAgents(adapter: CliAgentAdapter, onTitleChanged: (workspaceId: string, id: string, title: string, workspaceNamed: boolean) => Promise<void>) {
  let state: ReturnType<typeof createStore> | undefined;
  function createStore() {
    return createWorkspaceMetadataState(`${adapter.id}-agents.json`, (value) => {
      // Previous saved CLI Agent metadata called its Agent collection "sessions".
      if (Value.Check(previousStateSchema, value)) return { agents: value.sessions };
      return Value.Parse(stateSchema, value);
    }, () => ({ agents: [] }));
  }
  function store() { return state ??= createStore(); }
  const serialize = createKeyedOperationQueue();
  // Runtime readiness is separate from the durable claim. After a host restart,
  // inspect tmux; never replay a claimed initial prompt.
  const starting = new Map<string, Promise<void>>();

  function list(workspaceId: string): CliAgentRecord[] { return store().read(workspaceId).agents; }
  function get(workspaceId: string, id: string): CliAgentRecord {
    const agent = list(workspaceId).find((agent) => agent.id === id);
    if (!agent) throw new AgentsInTheCloudCoreError("agent_not_found", `${adapter.label} Agent not found: ${id}`);
    return agent;
  }

  // Called only inside the workspace queue, including the provisioning claim check.
  async function launch(workspaceId: string, input: WorkspaceAgentInput, settings: AgentWorkspaceParameters): Promise<string> {
    await adapter.requireSetup();
    const id = crypto.randomUUID();
    const agent: CliAgentRecord = { id, title: adapter.label, tmuxSession: `${adapter.id}-${id}`, input, kind: adapter.id, model: settings.model, thinkingLevel: settings.thinkingLevel };
    // Claim before side effects. Recovery must never submit the initial prompt twice.
    store().write(workspaceId, { agents: [...list(workspaceId), agent] });
    await start(workspaceId, agent, settings, input);
    if (!agent.error && input.text.trim()) void nameFromPrompt(workspaceId, agent).catch((error) => console.error(`Could not publish ${adapter.label} agent title ${id}`, error));
    return id;
  }

  async function start(workspaceId: string, agent: CliAgentRecord, settings: AgentWorkspaceParameters, input?: WorkspaceAgentInput): Promise<void> {
    const { id } = agent;
    const ready = Promise.withResolvers<void>();
    starting.set(id, ready.promise);
    // A claimed prompt is already work, even while the CLI is installing. Native
    // turn hooks take over this same busy state once the first turn begins.
    const pendingPrompt = !!input && !!(input.text.trim() || input.images.length || input.attachmentNotes.length);
    if (pendingPrompt) publishWorkspaceAgentBusy({ workspaceId, agentKey: agentKey(id), busy: true });
    try {
      await adapter.prepareWorkspace?.(workspaceId);
      const directory = `/tmp/agents-in-the-cloud-attachments/${adapter.id}-${id}`;
      const imagePaths: string[] = [];
      for (const [index, image] of (input?.images ?? []).entries()) {
        const extension = Object.entries(imageMimeByExtension).find(([, mime]) => mime === image.mimeType)?.[0];
        if (!extension) throw new Error(`Unsupported image type: ${image.mimeType}`);
        const path = `${directory}/${index}.${extension}`;
        await checkedWorkspaceShell(workspaceId, `mkdir -p ${shellQuote(directory)} && base64 -d > ${shellQuote(path)}`, image.data);
        imagePaths.push(path);
      }
      const connection = await prepareCliAgentConnection(workspaceId, id);
      const sessionDirectory = `/home/agents-in-the-cloud/.local/share/agents-in-the-cloud-agents/${id}`;
      const turnSignalCommand = `${sessionDirectory}/turn-signal.sh`;
      const launchSession: CliAgentSession = { id, directory: sessionDirectory, turnSignalCommand };
      // $1 is the TurnBoundary the CLI reports.
      await writeCliSessionFiles(workspaceId, launchSession, { "turn-signal.sh": `#!/bin/sh
exec curl --noproxy '*' --fail --silent --show-error --max-time 10 -X POST -H ${shellQuote("Authorization: Bearer " + connection.token)} ${shellQuote(new URL("/agent-turn-", connection.url).href)}"$1"
` });
      const env = { HOME: "/home/agents-in-the-cloud", ...await adapter.prepareSession(workspaceId, launchSession, connection) };
      const script = input
        ? adapter.launchScript(input, imagePaths, settings, launchSession)
        : await adapter.resumeScript!(workspaceId, settings, launchSession);
      // The launch script has its own diagnostic traps. Keep the lifecycle trap
      // in an outer shell so installation failures (before any native hook) also
      // finish the pending work. Normal turns still finish through native hooks.
      const exitSignal = `code=$?; if [ "$code" -eq 0 ]; then sh ${shellQuote(turnSignalCommand)} finished; else sh ${shellQuote(turnSignalCommand)} failed; fi`;
      const command = pendingPrompt
        ? `/bin/bash -c ${shellQuote(`trap ${shellQuote(exitSignal)} EXIT\n/bin/bash -c ${shellQuote(script)}`)}`
        : `/bin/bash -c ${shellQuote(script)}`;
      await checkedWorkspaceShell(workspaceId, buildObservableSessionCommand({ requireExistingServer: true, session: agent.tmuxSession, cwd: workspaceRoot, command, env, remainOnExit: true, passthrough: true, historyLimit: 10000 }));
      delete agent.error;
      store().write(workspaceId, { agents: list(workspaceId) });
    } catch (error) {
      // Startup failure is durable agent state, shown in its tab rather than discarded.
      agent.error = errorMessage(error);
      store().write(workspaceId, { agents: list(workspaceId) });
      await revokeAgentMcp(workspaceId, id);
      if (pendingPrompt) publishWorkspaceAgentBusy({ workspaceId, agentKey: agentKey(id), busy: false });
    } finally {
      starting.delete(id);
      ready.resolve();
    }
  }

  // The turn ends once its native history is complete, not when the CLI signals it,
  // and no later than the timeout so a CLI that never completes it cannot stay busy.
  async function settleTurn(workspaceId: string, id: string, signal: AbortSignal, reason: AgentTurnFinishReason): Promise<void> {
    if (!list(workspaceId).some((agent) => agent.id === id)) return;
    const deadline = Date.now() + turnSettleTimeoutMs;
    while (!signal.aborted && !await adapter.turnSettled!(workspaceId, id)) {
      if (Date.now() >= deadline) {
        // StopFailure may never write the normal stop marker; its timeout is expected.
        if (reason !== "stopFailure") console.error(`${adapter.label} history for ${id} did not settle within ${turnSettleTimeoutMs / 1000}s of its finished turn`);
        return;
      }
      await Bun.sleep(100);
    }
  }

  function restoreWorkspace(workspaceId: string): Promise<void> {
    return serialize(workspaceId, async () => {
      if (!adapter.resumeScript) return;
      for (const agent of list(workspaceId)) {
        // Legacy placeholders are not runnable agents. Existing (including dead)
        // panes belong to the current runtime and must not be relaunched.
        if (agent.kind !== adapter.id || (await terminalState(workspaceId, agent)).exists) continue;
        await start(workspaceId, agent, { model: agent.model, thinkingLevel: agent.thinkingLevel });
      }
    });
  }

  async function suggestSlug(agent: CliAgentRecord): Promise<string | undefined> {
    try {
      return await suggestAgentSlug(agent.input.text, agent.model ? parseModelRef(agent.model) : undefined);
    } catch (error) {
      console.error(`Could not name ${adapter.label} agent ${agent.id}`, error);
      return undefined;
    }
  }

  async function applyTitle(workspaceId: string, id: string, title: string, onlyIfUntitled: boolean): Promise<void> {
    const result = await serialize(workspaceId, async () => {
      const agent = list(workspaceId).find((item) => item.id === id);
      if (!agent && onlyIfUntitled) return undefined;
      const current = agent ?? get(workspaceId, id);
      if (onlyIfUntitled && (current.title !== adapter.label || current.historySlug)) return undefined;
      const previousTitle = current.title;
      current.title = title;
      current.historySlug = title;
      store().write(workspaceId, { agents: list(workspaceId) });
      // Like Builtin Agents, an unnamed Workspace (or one still named after this Agent) follows the Agent's name.
      const workspaceTitle = await getWorkspaceTitle(workspaceId);
      const workspaceNamed = workspaceTitle === null || workspaceTitle === previousTitle;
      if (workspaceNamed) await setWorkspaceTitle(workspaceId, title);
      return { workspaceNamed };
    });
    if (result) await onTitleChanged(workspaceId, id, title, result.workspaceNamed);
  }

  // The launch prompt names the tab; the same slug later names the exported history.
  async function nameFromPrompt(workspaceId: string, agent: CliAgentRecord): Promise<void> {
    const slug = await suggestSlug(agent);
    if (slug) await applyTitle(workspaceId, agent.id, slug, true);
  }

  function setTitle(workspaceId: string, id: string, title: string): Promise<void> {
    return applyTitle(workspaceId, id, title, false);
  }

  function suggestTitle(workspaceId: string, id: string): Promise<string | undefined> {
    return suggestSlug(get(workspaceId, id));
  }

  function create(workspaceId: string, settings: AgentWorkspaceParameters = {}): Promise<string> {
    return serialize(workspaceId, () => launch(workspaceId, settings.input ?? emptyAgentInput(), settings));
  }
  function prepareWorkspace(workspaceId: string, settings: AgentWorkspaceParameters = {}): Promise<void> {
    return serialize(workspaceId, async () => {
      if (!list(workspaceId).length) await launch(workspaceId, settings.input ?? emptyAgentInput(), settings);
    });
  }
  async function ready(workspaceId: string, id: string): Promise<CliAgentRecord> {
    get(workspaceId, id);
    await starting.get(id);
    return get(workspaceId, id);
  }
  async function terminalState(workspaceId: string, agent: CliAgentRecord): Promise<{ starting?: boolean; exists: boolean; ended: boolean; exitCode?: number }> {
    if (starting.has(agent.id)) return { starting: true, exists: false, ended: false };
    const result = await execWorkspaceShell(workspaceId, `tmux list-panes -t ${shellQuote(agent.tmuxSession)} -F '#{pane_dead}:#{pane_dead_status}'`);
    if (result.exitCode === 1) return { exists: false, ended: true };
    if (result.exitCode !== 0) throw new AgentsInTheCloudCoreError(`${adapter.id}_session_check_failed`, result.stderr.trim() || `Could not inspect ${adapter.label} terminal`);
    const [dead, status] = result.stdout.trim().split(":");
    return { exists: true, ended: dead === "1", exitCode: status ? Number(status) : undefined };
  }
  async function recordNamingPrompt(workspaceId: string, id: string, text: string): Promise<void> {
    await serialize(workspaceId, async () => {
      const agent = get(workspaceId, id);
      if (agent.input.text.trim()) return;
      agent.input = { ...agent.input, text };
      store().write(workspaceId, { agents: list(workspaceId) });
    });
  }
  async function exportHistory(workspaceId: string, id: string): Promise<void> {
    const historyFiles = adapter.historyFiles;
    if (!historyFiles) return;
    await serialize(workspaceId, async () => {
      const agent = list(workspaceId).find((item) => item.id === id);
      if (!agent || agent.error) return;
      if (!agent.historySlug) {
        agent.historySlug = await suggestSlug(agent);
        if (!agent.historySlug) return;
        store().write(workspaceId, { agents: list(workspaceId) });
      }
      await exportCliHistory(workspaceId, adapter.id, agent.id, agent.historySlug, await historyFiles(workspaceId, agent.id));
    });
  }
  async function close(workspaceId: string, id: string): Promise<void> {
    await exportHistory(workspaceId, id);
    await serialize(workspaceId, async () => {
      const agent = get(workspaceId, id);
      await revokeAgentMcp(workspaceId, id);
      if ((await terminalState(workspaceId, agent)).exists) await checkedWorkspaceShell(workspaceId, `tmux kill-session -t ${shellQuote(agent.tmuxSession)}`);
      store().write(workspaceId, { agents: list(workspaceId).filter((agent) => agent.id !== id) });
    });
  }
  async function exportWorkspaceHistory(workspaceId: string): Promise<void> {
    for (const agent of list(workspaceId)) await exportHistory(workspaceId, agent.id);
  }
  return { list, get, ready, settleTurn, create, prepareWorkspace, restoreWorkspace, terminalState, recordNamingPrompt, suggestTitle, setTitle, close, exportHistory, exportWorkspaceHistory };
}

export type CliAgents = ReturnType<typeof createCliAgents>;
