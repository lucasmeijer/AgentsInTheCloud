import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, runCommand, withCommandSignal } from "@agents-in-the-cloud/core";
import type { StartWorkspaceProcess } from "@agents-in-the-cloud/workspace-helper";
import { createTerminalProcesses, type RunTerminalProcessCommand, type TerminalProcesses } from "./terminal-process.ts";

/**
 * Commands for the tmux server in `tmuxDirectory`, never one the app itself may
 * run in. tmux silently falls back to /tmp when TMUX_TMPDIR does not exist, so
 * callers create it first.
 */
function environment(tmuxDirectory: string, env: Record<string, string> | undefined) {
  return { ...process.env, TMUX: undefined, TMUX_PANE: undefined, TMUX_TMPDIR: tmuxDirectory, ...env };
}

/**
 * Runs commands on this machine, the way the workspace helper runs them in a workspace:
 * the ambient command signal kills the command's whole process group.
 */
export function runLocally(tmuxDirectory: string): RunTerminalProcessCommand {
  return (start, options) => runCommand(start.argv, { cwd: start.workdir, env: environment(tmuxDirectory, start.env), stdin: options.stdin });
}

export function startLocally(tmuxDirectory: string): StartWorkspaceProcess {
  return (start) => {
    if (!start.terminal) throw new Error("Only terminal clients start locally");
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;
    const stdout = new ReadableStream<Uint8Array>({ start: (controller) => { output = controller; } });
    const terminal = new Bun.Terminal({
      name: "xterm-256color", ...start.terminal,
      data: (_terminal, data) => { if (!ended) output.enqueue(data); },
    });
    const child = Bun.spawn(start.argv, { cwd: start.workdir, env: environment(tmuxDirectory, start.env), terminal });
    const exited = child.exited.then((exitCode) => {
      ended = true;
      output.close();
      terminal.close();
      return { exitCode };
    });
    return {
      stdout,
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      exited,
      write: (data) => terminal.write(data),
      closeStdin() {},
      signal: (signal) => child.kill(signal),
      resize: ({ cols, rows }) => {
        terminal.resize(cols, rows);
        child.kill("SIGWINCH");
      },
      cancel: () => child.kill("SIGHUP"),
    };
  };
}

/**
 * Terminal processes on this machine, kept in `directory` on a tmux server of
 * their own, which they start as needed and which outlives the app.
 */
export function localTerminalProcesses(directory: string): TerminalProcesses {
  const tmuxDirectory = join(directory, "tmux");
  const run = runLocally(tmuxDirectory);
  const start = startLocally(tmuxDirectory);
  let server: Promise<void> | undefined;
  // Terminal processes never start a server themselves, the way a workspace's is supervised.
  // Every caller shares the start, so no caller's signal may cancel it.
  const ensureServer = () => server ??= withCommandSignal(new AbortController().signal, async () => {
    await mkdir(tmuxDirectory, { recursive: true });
    const started = await run({ argv: ["tmux", "start-server", ";", "set-option", "-g", "exit-empty", "off"], user: "agents-in-the-cloud" }, {});
    if (started.exitCode !== 0) throw new Error(`Could not start the terminal processes' tmux server: ${started.stderr.trim()}`);
  });
  return createTerminalProcesses({
    root: join(directory, "processes"),
    run: async (command, options) => { await ensureServer(); return run(command, options); },
    start,
  });
}

export async function clearLocalTerminalProcesses(directory: string): Promise<void> {
  const tmuxDirectory = join(directory, "tmux");
  await mkdir(tmuxDirectory, { recursive: true });
  await runLocally(tmuxDirectory)({ argv: ["tmux", "kill-server"], user: "agents-in-the-cloud" }, {});
  await rm(join(directory, "processes"), { recursive: true, force: true });
}

function appTerminalProcessesDirectory(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "terminal-processes");
}

let app: TerminalProcesses | undefined;

export function appTerminalProcesses(): TerminalProcesses {
  return app ??= localTerminalProcesses(appTerminalProcessesDirectory());
}

export function clearAppTerminalProcesses(): Promise<void> {
  return clearLocalTerminalProcesses(appTerminalProcessesDirectory());
}
