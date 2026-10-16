import { Client, credentials, Metadata, status, type ClientDuplexStream, type ServiceDefinition, type ServiceError } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";

/** Runs a workspace process from a host terminal: `bun <cli> <socket> <user> <workdir> <argv...>`. */
export const workspaceHelperCliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

export type WorkspaceHelperUser = "agents-in-the-cloud" | "root";
export type WorkspaceHelperSignal = "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGKILL";
export interface TerminalSize { cols: number; rows: number }

export interface WorkspaceExecStart {
  argv: string[];
  user: WorkspaceHelperUser;
  /** Absolute; defaults to /work. */
  workdir?: string;
  env?: Record<string, string>;
  /** Gives the process a stdin pipe. */
  stdin?: boolean;
  /** Runs the process on a PTY; output then arrives only on stdout. */
  terminal?: TerminalSize;
}

export type WorkspaceExit = { exitCode: number; signal?: undefined } | { exitCode?: undefined; signal: number };

/** A process running in a workspace through its helper. */
export interface WorkspaceProcess {
  /** Applies backpressure to the process. Cancelling either stream cancels the call. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Buffers without limit, so ignoring it never stalls stdout. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves after all output; rejects when the call fails. */
  readonly exited: Promise<WorkspaceExit>;
  write(data: string | Uint8Array): void;
  closeStdin(): void;
  signal(signal: WorkspaceHelperSignal): void;
  resize(size: TerminalSize): void;
  /** Ends the call, which kills the process group. */
  cancel(): void;
}

/** Starts a process in one particular workspace. */
export type StartWorkspaceProcess = (start: WorkspaceExecStart) => WorkspaceProcess;

export class WorkspaceHelperError extends Error {
  constructor(readonly code: status, message: string) {
    super(message);
    this.name = "WorkspaceHelperError";
  }
}

type ExecRequest =
  | { start: { argv: string[]; user: string; workdir?: string; env?: Record<string, string>; stdin?: boolean; terminal?: TerminalSize } }
  | { stdin: Uint8Array }
  | { closeStdin: Record<string, never> }
  | { signal: string }
  | { resize: TerminalSize };
type ExecResponse =
  | { response: "started"; started: { pid: number } }
  | { response: "stdout"; stdout: Buffer }
  | { response: "stderr"; stderr: Buffer }
  | { response: "exited"; exited: { status: "exitCode"; exitCode: number } | { status: "signal"; signal: number } };
type ExecCall = ClientDuplexStream<ExecRequest, ExecResponse>;

const definition = loadSync(fileURLToPath(new URL("../proto/workspace_helper.proto", import.meta.url)), { longs: Number, enums: String, defaults: false, oneofs: true });
// SAFETY: workspace_helper.proto defines WorkspaceHelper as a service whose Exec streams ExecRequest and ExecResponse, decoded with the options above.
const execMethod = (definition["agents_in_the_cloud.workspace_helper.v1.WorkspaceHelper"] as ServiceDefinition).Exec!;

const users = { "agents-in-the-cloud": "USER_AGENT", root: "USER_ROOT" } satisfies Record<WorkspaceHelperUser, string>;
const signals = { SIGHUP: "SIGNAL_HUP", SIGINT: "SIGNAL_INT", SIGTERM: "SIGNAL_TERM", SIGKILL: "SIGNAL_KILL" } satisfies Record<WorkspaceHelperSignal, string>;

const clients = new Map<string, Client>();

function client(socketPath: string): Client {
  let existing = clients.get(socketPath);
  if (!existing) {
    existing = new Client(`unix://${socketPath}`, credentials.createInsecure(), {
      // The helper is local; reconnect quickly once it is back, e.g. after a workspace restart.
      "grpc.initial_reconnect_backoff_ms": 100,
      "grpc.max_reconnect_backoff_ms": 1000,
    });
    clients.set(socketPath, existing);
  }
  return existing;
}

/** Drops the connection to a helper, e.g. once its workspace is gone. */
export function closeWorkspaceHelper(socketPath: string): void {
  clients.get(socketPath)?.close();
  clients.delete(socketPath);
}

/**
 * Starts a process in a workspace. `waitForReady` waits for a helper that is
 * still starting instead of failing at once; pair it with an abort signal.
 */
export function startWorkspaceProcess(socketPath: string, start: WorkspaceExecStart, options: { signal?: AbortSignal; waitForReady?: boolean } = {}): WorkspaceProcess {
  options.signal?.throwIfAborted();
  const call: ExecCall = client(socketPath).makeBidiStreamRequest(execMethod.path, execMethod.requestSerialize, execMethod.responseDeserialize, new Metadata({ waitForReady: options.waitForReady }), {});
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let outputCancelled = false;
  const cancelOutput = () => {
    outputCancelled = true;
    call.cancel();
  };
  const stdoutStream = new ReadableStream<Uint8Array>({
    start: (controller) => { stdout = controller; },
    // Paused calls stop reading, so HTTP/2 flow control holds the helper back.
    pull: () => { call.resume(); },
    cancel: cancelOutput,
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }));
  const stderrStream = new ReadableStream<Uint8Array>({ start: (controller) => { stderr = controller; }, cancel: cancelOutput });
  let exit: WorkspaceExit | undefined;
  let finished = false;
  const abort = () => call.cancel();
  options.signal?.addEventListener("abort", abort, { once: true });

  const exited = new Promise<WorkspaceExit>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      options.signal?.removeEventListener("abort", abort);
      if (error) {
        stdout.error(error);
        stderr.error(error);
        reject(error);
        return;
      }
      if (!outputCancelled) {
        stdout.close();
        stderr.close();
      }
      if (!exit) {
        reject(new WorkspaceHelperError(status.INTERNAL, "The workspace helper ended the call without an exit status"));
        return;
      }
      resolve(exit);
    };
    call.on("data", (response: ExecResponse) => {
      if (outputCancelled) return;
      switch (response.response) {
        case "started": return;
        case "stdout":
          stdout.enqueue(new Uint8Array(response.stdout));
          if (stdout.desiredSize! <= 0) call.pause();
          return;
        case "stderr": stderr.enqueue(new Uint8Array(response.stderr)); return;
        case "exited": exit = response.exited.status === "exitCode" ? { exitCode: response.exited.exitCode } : { signal: response.exited.signal }; return;
      }
    });
    call.on("error", (error: ServiceError) => {
      if (error.code === status.CANCELLED && options.signal?.aborted) {
        finish(options.signal.reason instanceof Error ? options.signal.reason : new Error(String(options.signal.reason)));
        return;
      }
      finish(new WorkspaceHelperError(error.code, error.details || error.message));
    });
    call.on("end", () => finish());
  });
  // Callers that only use the output streams still learn about failures there.
  exited.catch(() => {});

  call.write({ start: { argv: start.argv, user: users[start.user], workdir: start.workdir, env: start.env, stdin: start.stdin, terminal: start.terminal } });
  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    exited,
    write(data) {
      if (finished) return;
      call.write({ stdin: data instanceof Uint8Array ? data : new TextEncoder().encode(data) });
    },
    closeStdin() {
      if (finished) return;
      call.write({ closeStdin: {} });
    },
    signal(signal) {
      if (finished) return;
      call.write({ signal: signals[signal] });
    },
    resize(size) {
      if (finished) return;
      call.write({ resize: size });
    },
    cancel() {
      call.cancel();
    },
  };
}

const stdinChunkBytes = 64 * 1024;

export interface WorkspaceRunResult { exit: WorkspaceExit; stdout: Buffer; stderr: Buffer }

/** Runs a process to completion, collecting its output. */
export async function runWorkspaceProcess(socketPath: string, start: Omit<WorkspaceExecStart, "stdin" | "terminal">, options: { stdin?: string | Uint8Array; signal?: AbortSignal; waitForReady?: boolean } = {}): Promise<WorkspaceRunResult> {
  const process = startWorkspaceProcess(socketPath, { ...start, stdin: options.stdin !== undefined }, options);
  if (options.stdin !== undefined) {
    const input = options.stdin instanceof Uint8Array ? options.stdin : new TextEncoder().encode(options.stdin);
    for (let offset = 0; offset < input.byteLength; offset += stdinChunkBytes) process.write(input.subarray(offset, offset + stdinChunkBytes));
    process.closeStdin();
  }
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).arrayBuffer(), process.exited]);
  return { exit, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

export { status as WorkspaceHelperStatus } from "@grpc/grpc-js";
