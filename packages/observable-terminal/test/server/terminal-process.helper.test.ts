import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoProgram } from "@agents-in-the-cloud/core";
import { closeWorkspaceHelper, runWorkspaceProcess, startWorkspaceProcess } from "@agents-in-the-cloud/workspace-helper";
import { describeTerminalProcesses } from "./terminal-process-scenarios.ts";

describeTerminalProcesses("terminal processes through the workspace helper", async (tmuxDirectory) => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-process-helper-"));
  const binary = join(directory, "aitc-workspace-helper");
  await buildGoProgram(fileURLToPath(new URL("../../../workspace-helper/helper", import.meta.url)), binary, `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`);
  const socket = join(directory, "helper.sock");
  const state = join(directory, "state");
  const helper = Bun.spawn(["sudo", "-n", binary, "--listen", socket, "--state", state], { stdout: "inherit", stderr: "pipe" });
  const stderr = helper.stderr.pipeThrough(new TextDecoderStream()).getReader();
  let log = "";
  while (!log.includes("listening on")) {
    const { done, value } = await stderr.read();
    if (done) throw new Error(`The helper did not start: ${log}`);
    log += value;
  }
  void (async () => { while (!(await stderr.read()).done); })();
  return {
    async run(start, options) {
      const result = await runWorkspaceProcess(socket, { ...start, env: { ...start.env, TMUX_TMPDIR: tmuxDirectory } }, options);
      return { ...result, stderr: result.stderr.toString() };
    },
    start: (start) => startWorkspaceProcess(socket, { ...start, env: { ...start.env, TMUX_TMPDIR: tmuxDirectory } }),
    async close() {
      closeWorkspaceHelper(socket);
      helper.kill();
      await helper.exited;
      await Bun.spawn(["sudo", "-n", "rm", "-rf", directory]).exited;
    },
  };
});
