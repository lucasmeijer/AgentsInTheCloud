import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedSshAgent } from "../src/shared-ssh-agent.ts";

function uint(value: number): Buffer { const result = Buffer.alloc(4); result.writeUInt32BE(value); return result; }
function str(value: Buffer | string): Buffer { const bytes = Buffer.from(value); return Buffer.concat([uint(bytes.length), bytes]); }
function message(type: number, ...parts: Buffer[]): Buffer { return Buffer.concat([Buffer.from([type]), ...parts]); }
const identities = message(11);

class Client {
  private socket: Socket;
  readonly closed: Promise<void>;
  private buffer: Buffer = Buffer.alloc(0);
  private pending?: { resolve: (body: Buffer) => void; reject: (error: Error) => void };
  constructor(path: string) {
    this.socket = createConnection(path);
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));
    this.socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
      if (this.buffer.length >= 4 && this.buffer.length >= this.buffer.readUInt32BE(0) + 4) {
        const length = this.buffer.readUInt32BE(0);
        const body = this.buffer.subarray(4, length + 4);
        this.buffer = this.buffer.subarray(length + 4);
        const pending = this.pending!;
        this.pending = undefined;
        pending.resolve(body);
      }
    });
    this.socket.on("error", (error) => this.pending?.reject(error));
    this.socket.on("close", () => this.pending?.reject(new Error("Agent connection closed")));
  }
  request(body: Buffer, split = false): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) { reject(new Error("Agent connection closed")); return; }
      this.pending = { resolve, reject };
      const packet = str(body);
      if (split) { this.socket.write(packet.subarray(0, 2)); this.socket.write(packet.subarray(2, 7)); this.socket.write(packet.subarray(7)); }
      else this.socket.write(packet);
    });
  }
  close() { this.socket.destroy(); }
}

function keyCount(response: Buffer): number { expect(response[0]).toBe(12); return response.readUInt32BE(1); }
function keyBlobs(response: Buffer): string[] {
  const count = keyCount(response);
  let offset = 5;
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = response.readUInt32BE(offset); offset += 4;
    result.push(response.subarray(offset, offset + length).toString("base64")); offset += length;
    const commentLength = response.readUInt32BE(offset); offset += 4 + commentLength;
  }
  return result;
}

function signRequest(key: Buffer, data: Buffer = Buffer.from("arbitrary data")): Buffer { return message(13, str(key), str(data), uint(0)); }

async function userKey(directory: string, name: string) {
  const path = join(directory, name);
  const process = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path], { stdin: "ignore", stderr: "pipe" });
  expect(await process.exited).toBe(0);
  const publicText = await readFile(`${path}.pub`, "utf8");
  return { private: await readFile(path, "utf8"), blob: Buffer.from(publicText.split(" ")[1]!, "base64") };
}

describe("shared workspace-aware SSH agent", () => {
  let directory: string;
  let agent: SharedSshAgent;
  let keys: Map<string | undefined, string[]>;
  const clients: Client[] = [];
  async function client(scope?: string): Promise<Client> {
    const path = join(directory, `${scope ?? "global"}.sock`);
    await agent.listen(path, scope);
    const result = new Client(path); clients.push(result); return result;
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-agent-"));
    keys = new Map();
    agent = new SharedSshAgent(join(directory, "backend"), async (scope) => keys.get(scope) ?? []);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await agent.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("empty sockets acquire new keys live; deletion denies cached-key signing on the same connection", async () => {
    const connection = await client("a");
    expect(keyCount(await connection.request(identities))).toBe(0);
    const key = await userKey(directory, "key");
    keys.set("a", [key.private]);
    expect(keyBlobs(await connection.request(identities, true))).toEqual([key.blob.toString("base64")]);
    const signed = await connection.request(signRequest(key.blob));
    expect(signed[0]).toBe(14);
    const signatureBlob = signed.subarray(5);
    const signature = signatureBlob.subarray(4 + signatureBlob.readUInt32BE(0) + 4);
    const publicKey = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.blob.subarray(-32)]);
    expect(verify(null, Buffer.from("arbitrary data"), { key: publicKey, format: "der", type: "spki" }, signature)).toBe(true);
    keys.set("a", []);
    expect((await connection.request(signRequest(key.blob)))[0]).toBe(5);
    expect(keyCount(await connection.request(identities))).toBe(0);
  });

  test("concurrent workspace requests cannot list or sign another project's keys", async () => {
    const [a, b] = await Promise.all([userKey(directory, "a"), userKey(directory, "b")]);
    keys.set("a", [a.private]); keys.set("b", [b.private]);
    const [first, second, noWorkspaceTemplate] = await Promise.all([client("a"), client("b"), client()]);
    for (let i = 0; i < 4; i++) {
      const lists = await Promise.all([first.request(identities), second.request(identities), noWorkspaceTemplate.request(identities)]);
      expect(keyBlobs(lists[0]!)).toEqual([a.blob.toString("base64")]);
      expect(keyBlobs(lists[1]!)).toEqual([b.blob.toString("base64")]);
      expect(keyCount(lists[2]!)).toBe(0);
      expect((await Promise.all([first.request(signRequest(b.blob)), second.request(signRequest(a.blob))])).map((r) => r[0])).toEqual([5, 5]);
      expect((await Promise.all([first.request(signRequest(a.blob)), second.request(signRequest(b.blob))])).map((r) => r[0])).toEqual([14, 14]);
    }
  });

  test("clients cannot mutate, lock, or invoke arbitrary backend extensions", async () => {
    const key = await userKey(directory, "key"); keys.set("a", [key.private]);
    const connection = await client("a");
    for (const body of [message(18), message(17), message(19), message(22, str("password")), message(23, str("password")), message(27, str("arbitrary")), message(11, uint(1)), message(255)]) {
      expect((await connection.request(body))[0]).toBe(5);
    }
    expect((await connection.request(signRequest(key.blob)))[0]).toBe(14);
  });

  test("invalid private-key storage fails closed and does not poison other workspaces", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      keys.set("broken", ["not a private key"]);
      const broken = await client("broken");
      await expect(broken.request(identities)).rejects.toThrow();
      expect(log).toHaveBeenCalled();
      const key = await userKey(directory, "healthy"); keys.set("healthy", [key.private]);
      expect((await (await client("healthy")).request(signRequest(key.blob)))[0]).toBe(14);
    } finally { log.mockRestore(); }
  });

  test("malformed sign requests fail without affecting subsequent valid requests", async () => {
    const connection = await client("a");
    expect((await connection.request(message(13, uint(0xffffffff))))[0]).toBe(5);
    expect(keyCount(await connection.request(identities))).toBe(0);
  });

  test("all workspace listeners share exactly one signing process, stopped on close", async () => {
    const first = await client("a"); const second = await client("b");
    await Promise.all([first.request(identities), second.request(identities)]);
    const pattern = `^ssh-agent -D -a ${join(directory, "backend", "signer.sock")}$`;
    const process = Bun.spawn(["pgrep", "-f", pattern], { stdout: "pipe", stdin: "ignore" });
    expect(await process.exited).toBe(0);
    expect((await new Response(process.stdout).text()).trim().split("\n")).toHaveLength(1);
    await agent.close();
    const after = Bun.spawn(["pgrep", "-f", pattern], { stdout: "pipe", stdin: "ignore" });
    expect(await after.exited).toBe(1);
  });

  test("a terminated signer disconnects stale clients and fresh connections recover with current isolated keys", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const [a, b, replacement] = await Promise.all([userKey(directory, "a"), userKey(directory, "b"), userKey(directory, "replacement")]);
      keys.set("a", [a.private]); keys.set("b", [b.private]);
      const [first, second] = await Promise.all([client("a"), client("b")]);
      expect((await first.request(signRequest(a.blob)))[0]).toBe(14);
      expect((await second.request(signRequest(b.blob)))[0]).toBe(14);
      const pattern = `^ssh-agent -D -a ${join(directory, "backend", "signer.sock")}$`;
      async function signerPids(): Promise<string[]> {
        const command = Bun.spawn(["pgrep", "-f", pattern], { stdin: "ignore", stdout: "pipe" });
        const output = (await new Response(command.stdout).text()).trim();
        await command.exited;
        return output ? output.split("\n") : [];
      }
      const before = await signerPids();
      expect(before).toHaveLength(1);
      process.kill(Number(before[0]), "SIGKILL");
      await Promise.all([first.closed, second.closed]);
      expect(log).toHaveBeenCalled();
      await expect(first.request(signRequest(a.blob))).rejects.toThrow("closed");
      await expect(second.request(signRequest(b.blob))).rejects.toThrow("closed");
      keys.set("a", []); keys.set("b", [replacement.private]);
      const [freshA, freshB, newWorkspace] = await Promise.all([client("a"), client("b"), client("new")]);
      const lists = await Promise.all([freshA.request(identities), freshB.request(identities), newWorkspace.request(identities)]);
      expect(keyCount(lists[0]!)).toBe(0);
      expect(keyBlobs(lists[1]!)).toEqual([replacement.blob.toString("base64")]);
      expect(keyCount(lists[2]!)).toBe(0);
      expect((await freshA.request(signRequest(a.blob)))[0]).toBe(5);
      expect((await freshA.request(signRequest(replacement.blob)))[0]).toBe(5);
      expect((await freshB.request(signRequest(b.blob)))[0]).toBe(5);
      expect((await freshB.request(signRequest(replacement.blob)))[0]).toBe(14);
      keys.set("b", []);
      expect((await freshB.request(signRequest(replacement.blob)))[0]).toBe(5);
      keys.set("new", [a.private]);
      expect((await newWorkspace.request(signRequest(a.blob)))[0]).toBe(14);
      const after = await signerPids();
      expect(after).toHaveLength(1);
      expect(after[0]).not.toBe(before[0]);
      await agent.close();
      expect(await signerPids()).toEqual([]);
    } finally { log.mockRestore(); }
  });

  test("termination of AgentsInTheCloud terminates its shared signing backend", async () => {
    const script = join(directory, "parent.ts");
    const backend = join(directory, "child-backend");
    const socket = join(directory, "child.sock");
    await writeFile(script, `
      import { SharedSshAgent } from ${JSON.stringify(import.meta.resolve("../src/shared-ssh-agent.ts"))};
      const agent = new SharedSshAgent(${JSON.stringify(backend)}, async () => []);
      await agent.listen(${JSON.stringify(socket)});
      const child = Bun.spawn(["ssh-add", "-l"], { env: { ...process.env, SSH_AUTH_SOCK: ${JSON.stringify(socket)} }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      await child.exited;
      console.log("ready");
    `);
    const parent = Bun.spawn(["bun", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = parent.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      reader.releaseLock();
      const pattern = `^ssh-agent -D -a ${join(backend, "signer.sock")}$`;
      const before = Bun.spawn(["pgrep", "-f", pattern], { stdin: "ignore", stdout: "pipe" });
      expect(await before.exited).toBe(0);
      parent.kill("SIGTERM");
      expect(await parent.exited).not.toBe(0);
      await Bun.sleep(50);
      const after = Bun.spawn(["pgrep", "-f", pattern], { stdin: "ignore", stdout: "pipe" });
      expect(await after.exited).toBe(1);
    } finally {
      parent.kill();
      await parent.exited;
    }
  });

  test("deleting a workspace closes existing connections without affecting other workspaces", async () => {
    const first = await client("a"); const second = await client("b");
    await first.request(identities);
    await agent.remove(join(directory, "a.sock"));
    await expect(first.request(identities)).rejects.toThrow();
    expect(keyCount(await second.request(identities))).toBe(0);
    await agent.listen(join(directory, "a.sock"), "a");
    expect(keyCount(await (await client("a")).request(identities))).toBe(0);
  });
});
