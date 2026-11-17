import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { AgentsInTheCloudCoreError, isNotFoundError } from "@agents-in-the-cloud/core";

const failure = Buffer.from([5]);
const maxPacketLength = 256 * 1024;

function packet(body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

async function* packets(socket: Socket): AsyncGenerator<Buffer> {
  let buffered: Buffer = Buffer.alloc(0);
  for await (const chunk of socket) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length < 1 || length > maxPacketLength) throw new Error("Invalid SSH agent packet length");
      if (buffered.length < length + 4) break;
      yield buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
    }
  }
  if (buffered.length) throw new Error("Truncated SSH agent packet");
}

function permitted(body: Buffer): boolean {
  if (body[0] === 11) return body.length === 1;
  if (body[0] === 13) return true;
  if (body[0] !== 27 || body.length < 5) return false;
  const length = body.readUInt32BE(1);
  return length === 24 && body.subarray(5, 5 + length).toString() === "session-bind@openssh.com";
}

async function sshAdd(socketPath: string, args: string[], privateKey?: string): Promise<void> {
  const child = Bun.spawn(["ssh-add", ...args], {
    env: { ...process.env, SSH_AUTH_SOCK: socketPath },
    stdin: privateKey === undefined ? "ignore" : new Blob([`${privateKey.trimEnd()}\n`]), stdout: "ignore", stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0) throw new AgentsInTheCloudCoreError("ssh_agent_failed", stderr.trim() || "ssh-add failed");
}

/** One signing backend, with trusted workspace identity supplied by each listener.
 * All key synchronization AND protocol exchanges share a lock. A client retains its
 * own backend connection, so OpenSSH verifies session bindings even across key changes and concurrent workspaces.
 * Only read/sign/bind operations are exposed, never backend key-management commands.
 */
export class SharedSshAgent {
  private child?: ChildProcess;
  private backendPath: string;
  private loadedKeys?: string;
  private upstreams = new Set<Socket>();
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Map<string, { server: Server; clients: Set<Socket> }>();
  private exitHandler = () => { this.child?.kill("SIGTERM"); };
  private signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(private directory: string, private loadKeys: (workspaceTemplateId?: string) => Promise<string[]>) {
    this.backendPath = join(directory, "signer.sock");
    process.on("exit", this.exitHandler);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        this.exitHandler();
        // Preserve the default termination behavior when AgentsInTheCloud has no other
        // shutdown handler. If it does, that handler owns process termination.
        if (process.listenerCount(signal) === 1) {
          process.off(signal, handler);
          process.kill(process.pid, signal);
        }
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private backendFailed(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    console.error("[ssh-agent] Shared signing backend failed:", error);
    this.child = undefined;
    this.loadedKeys = undefined;
    // Session bindings belong to the dead backend connection. Never silently
    // reconnect or replay requests: clients must establish fresh SSH sessions.
    for (const upstream of this.upstreams) upstream.destroy();
    for (const listener of this.listeners.values()) {
      for (const client of listener.clients) client.destroy();
    }
  }

  private async startBackend(): Promise<ChildProcess> {
    if (this.child) return this.child;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await rm(this.backendPath, { force: true });
    const child = spawn("ssh-agent", ["-D", "-a", this.backendPath], { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    let stderr = "";
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
      this.backendFailed(child, error);
    });
    child.once("exit", (code, signal) => {
      this.backendFailed(child, new AgentsInTheCloudCoreError("ssh_agent_failed", `Shared SSH signing backend exited (${signal ?? code}): ${stderr.trim()}`));
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new AgentsInTheCloudCoreError("ssh_agent_failed", stderr.trim() || "Shared SSH signing backend exited");
      try {
        if ((await stat(this.backendPath)).isSocket()) return child;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      await Bun.sleep(20);
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
    throw new AgentsInTheCloudCoreError("ssh_agent_failed", "Timed out waiting for shared SSH signing backend");
  }

  private async synchronize(child: ChildProcess, workspaceTemplateId?: string): Promise<void> {
    const keys = await this.loadKeys(workspaceTemplateId);
    const digest = createHash("sha256").update(JSON.stringify(keys)).digest("hex");
    if (digest === this.loadedKeys) return;
    this.loadedKeys = undefined;
    await sshAdd(this.backendPath, ["-D"]);
    for (const key of keys) await sshAdd(this.backendPath, ["-"], key);
    if (this.child !== child) throw new AgentsInTheCloudCoreError("ssh_agent_failed", "Shared SSH signing backend changed during key synchronization");
    this.loadedKeys = digest;
  }

  private async serve(client: Socket, workspaceTemplateId?: string): Promise<void> {
    let upstream: Socket | undefined;
    let responses: AsyncGenerator<Buffer> | undefined;
    try {
      for await (const body of packets(client)) {
        if (!permitted(body)) {
          client.write(packet(failure));
          continue;
        }
        const response = await this.exclusive(async () => {
          if (client.destroyed) return failure;
          const child = await this.startBackend();
          if (client.destroyed) return failure;
          if (!upstream) {
            upstream = createConnection(this.backendPath);
            this.upstreams.add(upstream);
            await new Promise<void>((resolve, reject) => {
              upstream!.once("connect", resolve);
              upstream!.once("error", reject);
            });
            responses = packets(upstream);
          }
          await this.synchronize(child, workspaceTemplateId);
          if (client.destroyed || this.child !== child) return failure;
          upstream.write(packet(body));
          const response = await responses!.next();
          if (response.done) throw new AgentsInTheCloudCoreError("ssh_agent_failed", "Shared SSH signing backend closed its connection");
          return response.value;
        });
        if (!client.destroyed) client.write(packet(response));
      }
    } catch (error) {
      console.error("[ssh-agent] Workspace agent connection failed:", error);
      if (!client.destroyed) client.end(packet(failure));
    } finally {
      if (upstream) {
        this.upstreams.delete(upstream);
        upstream.destroy();
      }
      client.destroy();
    }
  }

  async listen(socketPath: string, workspaceTemplateId?: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.listeners.has(socketPath)) return;
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
      await rm(socketPath, { force: true });
      const clients = new Set<Socket>();
      const server = createServer((client) => {
        clients.add(client);
        client.once("close", () => clients.delete(client));
        void this.serve(client, workspaceTemplateId);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        await chmod(socketPath, 0o600);
        this.listeners.set(socketPath, { server, clients });
      } catch (error) {
        server.close();
        await rm(socketPath, { force: true });
        throw error;
      }
    });
  }

  async remove(socketPath: string): Promise<void> {
    await this.exclusive(async () => {
      const listener = this.listeners.get(socketPath);
      if (!listener) return;
      this.listeners.delete(socketPath);
      for (const client of listener.clients) client.destroy();
      await new Promise<void>((resolve, reject) => listener.server.close((error) => error ? reject(error) : resolve()));
      await rm(socketPath, { force: true });
    });
  }

  async close(): Promise<void> {
    for (const path of this.listeners.keys()) await this.remove(path);
    await this.exclusive(async () => {
      const child = this.child;
      this.child = undefined;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await exited;
      }
      this.loadedKeys = undefined;
      await rm(this.backendPath, { force: true });
      process.off("exit", this.exitHandler);
      for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
    });
  }
}
