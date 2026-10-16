import { EventEmitter } from "node:events";
import { constants } from "node:os";
import { Readable, Writable } from "node:stream";
import { query, type EffortLevel, type Options, type SDKMessage, type SDKUserMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { resolveWorkspace, startInWorkspace, workspaceRoot } from "@agents-in-the-cloud/workspace";
import { claudeConfigDirectory, claudeExecutable, claudeMcpConfigPath } from "./setup.ts";

/** Which native conversation the process continues. A fork resumes `resume` into the new `sessionId`. */
type ClaudeSessionStart = { sessionId: string; resume?: string; forkSession?: boolean };

/** Prompts stay open for the life of the process; Claude queues those sent while it works. */
function inputQueue() {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (pending.length) yield pending.shift()!;
      if (ended) return;
      await new Promise<void>(resolve => wake = resolve);
    }
  }
  return {
    messages: messages(),
    push(message: SDKUserMessage) { pending.push(message); wake?.(); },
    end() { ended = true; wake?.(); },
  };
}

/** The SDK drives a child process; this one runs in the workspace. */
class WorkspaceSpawnedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(private readonly child: ReturnType<typeof startInWorkspace>) {
    super();
    this.stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) { child.write(chunk); callback(); },
      final(callback) { child.closeStdin(); callback(); },
    });
    this.stdout = Readable.from(child.stdout);
    void child.exited.then((exit) => {
      if (exit.signal === undefined) this.exitCode = exit.exitCode;
      else {
        // SAFETY: os.constants.signals is keyed by signal name.
        const names = Object.keys(constants.signals) as NodeJS.Signals[];
        this.signalCode = names.find((name) => constants.signals[name] === exit.signal)!;
      }
      this.emit("exit", this.exitCode, this.signalCode);
    }, (error: Error) => this.emit("error", error));
  }

  kill(signal: NodeJS.Signals): boolean {
    if (signal !== "SIGTERM" && signal !== "SIGKILL" && signal !== "SIGINT" && signal !== "SIGHUP") throw new Error(`Unsupported signal for a workspace process: ${signal}`);
    this.child.signal(signal);
    this.killed = true;
    return true;
  }
}

/** Stdio stays private: no listening port or raw provider credential in a workspace. */
export async function openClaudeTransport(workspaceId: string, agentId: string, start: ClaudeSessionStart & { instructions: string; model?: string; effort?: EffortLevel }, message: (message: SDKMessage) => void, failed: (error: Error) => void) {
  await resolveWorkspace(workspaceId);
  const input = inputQueue();
  let stderr = "";
  let closing = false;
  const options: Options = {
    // The process runs in the workspace; nothing from AgentsInTheCloud's own environment may reach it.
    env: { CLAUDE_AGENT_SDK_CLIENT_APP: "agents-in-the-cloud", CLAUDE_CONFIG_DIR: claudeConfigDirectory(agentId) },
    cwd: workspaceRoot,
    pathToClaudeCodeExecutable: claudeExecutable,
    spawnClaudeCodeProcess(options) {
      const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const child = startInWorkspace(workspaceId, { argv: [claudeExecutable, ...options.args], user: "agents-in-the-cloud", workdir: workspaceRoot, env, stdin: true }, { signal: options.signal });
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-16000);
      })().catch(() => {});
      return new WorkspaceSpawnedProcess(child);
    },
    extraArgs: { "mcp-config": claudeMcpConfigPath(agentId) },
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code", append: start.instructions },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // No client surface answers these yet; Claude asks in its reply instead.
    disallowedTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
    includePartialMessages: true,
    thinking: { type: "adaptive", display: "summarized" },
    model: start.model,
    effort: start.effort,
  };
  if (!start.resume) options.sessionId = start.sessionId;
  else {
    options.resume = start.resume;
    if (start.forkSession) { options.forkSession = true; options.sessionId = start.sessionId; }
  }
  const native = query({ prompt: input.messages, options });
  const reading = (async () => {
    try {
      for await (const value of native) message(value);
      if (!closing) failed(new Error(`Claude Code exited${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    } catch (error) {
      if (closing) return;
      const reason = error instanceof Error ? error.message : String(error);
      failed(new Error(stderr.trim() ? `${reason}: ${stderr.trim()}` : reason));
    }
  })();
  return {
    query: native,
    send(value: SDKUserMessage) { input.push(value); },
    async close() {
      closing = true;
      input.end();
      native.close();
      await reading;
    },
  };
}
export type ClaudeTransport = Awaited<ReturnType<typeof openClaudeTransport>>;
