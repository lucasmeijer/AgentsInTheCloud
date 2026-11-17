import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { hostSocketPath, parseHostRequest, type HostReply, type HostResult, type HostCommand, type HostSample, type PrivateNetworkFirewallEntry } from "../protocol.ts";
import { sampleHost } from "./sampler.ts";

export class HostService {
  private lastSample?: HostSample;
  private sampling?: Promise<HostSample>;
  constructor(private readonly sample: () => Promise<HostSample>, private readonly privateNetworkAccess: (destinations: PrivateNetworkFirewallEntry[]) => Promise<void>) {}

  async handle(request: HostCommand): Promise<HostResult> {
    switch (request.operation) {
      case "sample": {
        if (this.sampling) return this.sampling;
        if (!request.fresh && this.lastSample) return this.lastSample;
        this.sampling = this.sample().then(sample => this.lastSample = sample).finally(() => { this.sampling = undefined; });
        return this.sampling;
      }
      case "private-network-access": {
        await this.privateNetworkAccess(request.destinations);
        return null;
      }
    }
  }
}

export async function startHostService(options: { root: string; effectiveMemory: number; privateNetworkAccess: (destinations: PrivateNetworkFirewallEntry[]) => Promise<void>; socketPath?: string }) {
  const socketPath = options.socketPath ?? hostSocketPath;
  await mkdir(dirname(socketPath), { recursive: true });
  const service = new HostService(() => sampleHost(options.root, options.effectiveMemory), options.privateNetworkAccess);
  const server = createServer(socket => {
    const reply = (value: HostReply) => socket.end(`${JSON.stringify(value)}\n`);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    socket.on("close", () => lines.close());
    socket.on("error", error => { console.error("Host connection failed", error); socket.destroy(); });
    lines.once("line", line => {
      void (async () => reply({ type: "result", value: await service.handle(parseHostRequest(line)) }))()
        .catch(error => reply({ type: "error", message: String(error) }));
    });
  });
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return server;
}
