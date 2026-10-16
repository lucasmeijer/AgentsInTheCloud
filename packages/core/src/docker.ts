import { runCommand, commandSignal, withCommandSignal } from "./command-scope.ts";
import { AgentsInTheCloudCoreError } from "./errors.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandInput = string | Uint8Array;
type CommandOptions = { stdin?: CommandInput };

export async function runDocker(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const signal = commandSignal();
  const execution = signal && args[0] === "exec" ? cancellableExec(args) : undefined;
  try {
    const result = await runCommand(["docker", ...(execution?.args ?? args)], options);
    return { ...result, stdout: result.stdout.toString() };
  } finally {
    if (execution && signal?.aborted) {
      // Killing a Docker CLI does not kill the process inside the container.
      await withCommandSignal(AbortSignal.timeout(10_000), async () => {
        const stopped = await runCommand(["docker", "exec", "--user", "root", execution.container, "sh", "-c", `touch ${execution.pidFile}.cancel; if test -f ${execution.pidFile}; then kill -9 -"$(cat ${execution.pidFile})" 2>/dev/null || true; rm -f ${execution.pidFile}; fi`]);
        if (stopped.exitCode !== 0) throw new Error(`Could not stop cancelled container command: ${stopped.stderr}`);
      });
    }
  }
}

export async function requireDocker(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const result = await runDocker(args, options);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || `docker ${args[0] ?? ""} failed`;
    if (message.includes("all predefined address pools have been fully subnetted")) {
      throw new AgentsInTheCloudCoreError(
        "docker_network_capacity_exhausted",
        "Docker has run out of network address space. Delete workspaces you no longer need, then try again. Parking a workspace won’t free its network. To keep more workspaces, configure larger default-address-pools in Docker’s daemon settings (Docker Desktop: Settings → Docker Engine). Changing pools requires a Docker restart and applies only to new networks.",
        { stderr: result.stderr, command: args },
      );
    }
    throw new AgentsInTheCloudCoreError("docker_unavailable", message);
  }
  return result;
}

/** timeout owns the process group; its child records that parent PID for cancellation. */
function cancellableExec(args: string[]) {
  const valueOptions = new Set(["--user", "-u", "--env", "-e", "--env-file", "--workdir", "-w", "--detach-keys"]);
  let index = 1;
  while (args[index]?.startsWith("-")) index += valueOptions.has(args[index]!) ? 2 : 1;
  const container = args[index]!;
  const pidFile = `/tmp/agents-in-the-cloud-command-${crypto.randomUUID()}.pid`;
  const script = `echo "$PPID" > ${pidFile}; if test -f ${pidFile}.cancel; then rm -f ${pidFile} ${pidFile}.cancel; exit 125; fi; "$@"; status=$?; rm -f ${pidFile} ${pidFile}.cancel; exit "$status"`;
  return { container, pidFile, args: [...args.slice(0, index + 1), "timeout", "--signal=KILL", "600", "sh", "-c", script, "agents-in-the-cloud-command", ...args.slice(index + 1)] };
}
