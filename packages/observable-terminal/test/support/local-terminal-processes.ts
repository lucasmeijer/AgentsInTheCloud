import { mkdir } from "node:fs/promises";
import type { RunTerminalProcessCommand } from "../../src/server/terminal-process.ts";

export { clearLocalTerminalProcesses, localTerminalProcesses as terminalProcessesIn, runLocally, startLocally } from "../../src/server/local-terminal-processes.ts";

/**
 * Starts a tmux server in `tmuxDirectory` through `run`, like a workspace's
 * supervised one: terminal processes never start a server themselves. tmux
 * silently falls back to /tmp when TMUX_TMPDIR does not exist, so this refuses
 * to go on with any server but its own.
 */
export async function startPrivateTmux(run: RunTerminalProcessCommand, tmuxDirectory: string): Promise<{ stop(): Promise<void> }> {
  await mkdir(tmuxDirectory, { recursive: true });
  const tmux = async (...args: string[]) => {
    const result = await run({ argv: ["tmux", ...args], user: "agents-in-the-cloud", workdir: "/" }, {});
    if (result.exitCode !== 0) throw new Error(`tmux ${args[0]} failed: ${result.stderr}`);
    return result.stdout.toString().trim();
  };
  const keepalive = `keepalive-${crypto.randomUUID()}`;
  await tmux("new-session", "-d", "-s", keepalive);
  const socket = await tmux("display-message", "-p", "-t", `=${keepalive}`, "#{socket_path}");
  if (!socket.startsWith(`${tmuxDirectory}/`)) {
    await tmux("kill-session", "-t", `=${keepalive}`);
    throw new Error(`Tests must use their own tmux server, not ${socket}`);
  }
  return { stop: async () => { await Bun.spawn(["tmux", "-S", socket, "kill-server"], { stderr: "ignore" }).exited; } };
}
