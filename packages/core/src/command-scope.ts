import { AsyncLocalStorage } from "node:async_hooks";

const signals = new AsyncLocalStorage<AbortSignal>();

export function withCommandSignal<T>(signal: AbortSignal, work: () => T): T {
  return signals.run(signal, work);
}

export function commandSignal(): AbortSignal | undefined {
  return signals.getStore();
}

export async function waitForCommand<T>(work: Promise<T>): Promise<T> {
  const signal = commandSignal();
  if (!signal) return work;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([cancelled, work]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function runCommand(args: string[], options: { stdin?: string | Uint8Array; env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  const signal = commandSignal();
  signal?.throwIfAborted();
  const proc = Bun.spawn(args, { ...options, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  const abort = () => killCommandGroup(proc.pid);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.stdin !== undefined) proc.stdin.write(options.stdin);
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    signal?.throwIfAborted();
    return { exitCode, stdout: Buffer.from(stdout), stderr };
  } catch (error) {
    abort();
    await proc.exited;
    throw error;
  } finally { signal?.removeEventListener("abort", abort); }
}

export function killCommandGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
}
