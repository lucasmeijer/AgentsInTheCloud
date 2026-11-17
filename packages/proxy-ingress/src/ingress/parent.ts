import { requireTailscaleHttps } from "../../../shared/src/tailscale.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { createTailscaleOriginPublisher, defaultTailscaleLocalApiSocketPath, tailscaleLocalApiRequest, type PortRange } from "./tailscale-serve.ts";

const originSchema = Type.Object({ origin: Type.String() });
const statusSchema = Type.Object({ BackendState: Type.Literal("Running"), Self: Type.Object({ DNSName: Type.String() }), CertDomains: Type.Optional(Type.Union([Type.Null(), Type.Array(Type.String())])) });

export interface ParentOriginPublisher {
  kind: "agents-in-the-cloud" | "tailscale" | "localhost" | "system";
  refresh?: boolean;
  publish(port: number): Promise<string>;
  unpublish?(port: number): Promise<void>;
}
export const parentIngressSocket = "/run/agents-in-the-cloud-parent/ingress.sock";
export function createLocalOriginPublisher(): ParentOriginPublisher {
  return { kind: "localhost", async publish(port) { return `http://localhost:${port}`; } };
}
export function createParentAgentsInTheCloudPublisher(socketPath = parentIngressSocket): ParentOriginPublisher {
  return { kind: "agents-in-the-cloud", refresh: true, async publish(port) {
    const body = JSON.stringify({ port, protocol: "http" });
    const result = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath, path: "/origins", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (response.statusCode !== 200) reject(new Error(`Parent ingress publication failed: HTTP ${response.statusCode}: ${text}`));
          else resolve(text);
        });
      });
      req.on("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error("Parent ingress publication timed out")));
      req.end(body);
    });
    const parsed: unknown = JSON.parse(result);
    if (!Value.Check(originSchema, parsed)) throw new Error("Parent ingress did not return an origin");
    const url = new URL(parsed.origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== parsed.origin || url.username || url.password) throw new Error("Parent ingress returned an invalid origin");
    return url.origin;
  } };
}

export function createTailscaleParentPublisher(socketPath = defaultTailscaleLocalApiSocketPath, portRange?: PortRange): ParentOriginPublisher {
  async function connectedPublisher(requireHttps: boolean) {
    const status: unknown = JSON.parse(await tailscaleLocalApiRequest(socketPath, "GET", "/localapi/v0/status"));
    if (!Value.Check(statusSchema, status)) throw new Error("Tailscale has no DNS name; connect Tailscale before publishing a preview");
    const host = status.Self.DNSName.replace(/\.$/, "");
    if (!host) throw new Error("Tailscale has no DNS name; connect Tailscale before publishing a preview");
    if (requireHttps) requireTailscaleHttps(host, status.CertDomains);
    return { host, publisher: createTailscaleOriginPublisher({ host, socketPath, portRange }) };
  }
  return {
    kind: "tailscale",
    async publish(port) {
      const { host, publisher } = await connectedPublisher(true);
      await publisher.publish(port);
      return `https://${host}:${port}`;
    },
    async unpublish(port) {
      const { publisher } = await connectedPublisher(false);
      await publisher.unpublish(port);
    },
  };
}

export function createSystemOriginPublisher(portRange?: PortRange, fetcher: (url: string) => Promise<Response> = fetch): ParentOriginPublisher {
  const tailscale = createTailscaleParentPublisher(defaultTailscaleLocalApiSocketPath, portRange);
  return { kind: "system", refresh: true, async publish(port) {
    const response = await fetcher("http://127.0.0.1:3001/access");
    if (!response.ok) throw new Error(`System access status failed: ${response.status}`);
    const status: unknown = await response.json();
    if (!Value.Check(Type.Object({ mode: Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")]), localPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })) }), status)) throw new Error("Invalid System access status");
    if (status.mode === "tailscale") return tailscale.publish(port);
    if (!status.localPort) throw new Error("System's local port has not been published yet");
    return `http://p${port}.agents-in-the-cloud.localhost:${status.localPort}`;
  } };
}

export async function detectParentOriginPublisher(portRange?: PortRange, hasPath: (path: string) => boolean = existsSync): Promise<ParentOriginPublisher> {
  if (hasPath("/run/agents-in-the-cloud-parent")) return createParentAgentsInTheCloudPublisher();
  if (hasPath("/run/agents-in-the-cloud-system/access-v1")) return createSystemOriginPublisher(portRange);
  if (hasPath(dirname(defaultTailscaleLocalApiSocketPath))) return createTailscaleParentPublisher(defaultTailscaleLocalApiSocketPath, portRange);
  return createLocalOriginPublisher();
}
