import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTask, defineTool, type TaskId } from "@earendil-works/pi-durable";
import type { TerminalProcesses } from "@agents-in-the-cloud/observable-terminal/server";
import { workspaceRoot, workspaceTerminalProcesses } from "@agents-in-the-cloud/workspace";
import { withCommandSignal } from "@agents-in-the-cloud/core";
import { Type, type Static } from "typebox";
import { bashToolDefinition, forcedColorEnvironment, formatBashOutput } from "@agents-in-the-cloud/agent/server/bash-tool";

type BashRequest = {
  id: string;
  command: string;
  deadline: number;
  cwd: string;
  env: Record<string, string>;
};

type BashResult =
  | { status: "uncertain"; message: string }
  | { status: "done"; exitCode: number | null; aborted: boolean; timedOut: boolean; output: string; displayAnsi: string; fullOutputPath: string };

const bashStructuredOutputSchema = Type.Object({
  output: Type.String({ description: "Combined stdout and stderr, as the model sees it" }),
  truncated: Type.Boolean({ description: "Whether output was cut; the full output is in fullOutputPath" }),
  fullOutputPath: Type.Optional(Type.String()),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  timedOut: Type.Boolean(),
  aborted: Type.Boolean(),
});

type BashInput = { request: BashRequest; timeout: number };
type BashCheckpoint = { phase: "execute" };
const BashChild = defineDoc<{ id: TaskId<BashResult> | null }>({
  kind: "agents-in-the-cloud.bash-child", version: 1, scope: "task", initial: () => ({ id: null }), checkpointWhen: () => false,
});

export function createDurableBashExtension(workspaceId: string, processes: TerminalProcesses = workspaceTerminalProcesses(workspaceId)) {
  /**
   * Waits for tmux to report the process ended, and turns that into the operation's outcome.
   * A restart reruns the phase, which reattaches to the same terminal process.
   */
  async function settle(id: string, context: Context): Promise<BashResult> {
    const signal = context.abortSignal;
    const state = signal ? await withCommandSignal(signal, () => processes.waitForEnd(id)) : await processes.waitForEnd(id);
    if (state.state === "missing") return { status: "uncertain", message: "The command's terminal process is missing, so the command was not run again." };
    if (state.state === "lost") return { status: "uncertain", message: "The command's terminal disappeared before it recorded a result. The command was not run again." };
    return {
      status: "done", exitCode: state.exitCode, aborted: state.aborted, timedOut: state.timedOut,
      output: state.output.text, displayAnsi: state.output.ansi, fullOutputPath: processes.textFile(id),
    };
  }

  const operation = defineTask<BashInput, BashCheckpoint, BashResult>({
    name: "agents-in-the-cloud.bash-operation", version: 1,
    initial: () => ({ phase: "execute" }),
    phases: {
      async execute(task, runtime, context) {
        const { request } = task.input;
        // Only this first invocation can start the command. If it dies before
        // starting, a retry reports uncertainty rather than guessing whether a
        // missing process means a command never ran.
        const invocation = crypto.randomUUID();
        const first = await runtime.memo("launch-invocation", invocation, context);
        if (first === invocation) {
          await processes.start({ id: request.id, command: request.command, cwd: request.cwd, env: request.env, deadline: request.deadline, keepText: true });
        }
        const result = await settle(request.id, context);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
        await processes.release(request.id);
      },
    },
    async abort(task, runtime, context) {
      // Host close cancels a run invocation, but never invokes this protocol.
      // A durable abort mark does: Stop is retried after restart until acknowledged.
      const { id } = task.input.request;
      await processes.stop(id);
      const result = await settle(id, context);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result, reason: result.status === "uncertain" ? result.message : "Stopped by user" } }), context);
      await processes.release(id);
    },
  });
  const bash = defineTool({
    ...bashToolDefinition,
    replay: "safe",
    structuredOutputSchema: bashStructuredOutputSchema,
    async execute(args, api, context) {
      const child = await api.commit(async (tx) => {
        const binding = await tx.doc(BashChild, api.taskId);
        if (binding.id !== null) return binding.id;
        const timeout = Math.max(1, args.timeout ?? 600);
        const request: BashRequest = {
          id: crypto.randomUUID(), command: args.command, deadline: Date.now() + timeout * 1000, cwd: workspaceRoot,
          env: Object.fromEntries(Object.entries({
            ...forcedColorEnvironment, COLUMNS: 120, LINES: 30,
            EDITOR: "true", GIT_EDITOR: "true", VISUAL: "true", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: 0,
          }).map(([key, value]) => [key, String(value)])),
        };
        binding.id = await tx.createTask(operation, { request, timeout }, { ownership: { kind: "task", taskId: api.taskId } });
        return binding.id;
      }, context);
      const record = (await api.getTask(child, context))!;
      // SAFETY: this ID is atomically bound above to our version-1 operation task and its BashInput.
      const input = record.input as BashInput;
      await api.details({ workspaceId, terminalProcessId: input.request.id, command: input.request.command }, context);
      const settled = await api.waitForTask(child, context);
      if (settled.state.outcome.status === "faulted" || settled.state.outcome.status === "failed") throw new Error(settled.state.outcome.error.message);
      if (settled.state.outcome.status !== "completed") throw new Error(`Command operation ${settled.state.outcome.status}`);
      const result = settled.state.outcome.result;
      if (result.status === "uncertain") return { isError: true, output: [{ type: "text", text: result.message }], diagnostics: [{ severity: "error", code: "uncertain", message: result.message }] };
      const formatted = formatBashOutput(result.output, result.displayAnsi, result.fullOutputPath);
      let text = formatted.output || "(no output)";
      if (result.aborted) text += "\n\nCommand aborted";
      else if (result.timedOut) text += `\n\nCommand timed out after ${input.timeout} seconds`;
      else if (result.exitCode !== 0) text += `\n\nCommand exited with code ${result.exitCode}`;
      const structuredOutput: Static<typeof bashStructuredOutputSchema> = { output: formatted.output, truncated: formatted.modelTruncated,
        exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted };
      if (formatted.modelTruncated) structuredOutput.fullOutputPath = result.fullOutputPath;
      return {
        output: [{ type: "text", text }],
        structuredOutput,
        details: { workspaceId, exitCode: result.exitCode, displayAnsi: formatted.displayAnsi, aborted: result.aborted,
          timedOut: result.timedOut, fullOutputPath: result.fullOutputPath },
      };
    },
  });
  return defineExtension({ name: "agents-in-the-cloud.bash", tools: [bash], tasks: [operation] });
}
