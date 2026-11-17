export const workspaceGatewayPort = 2999;
export const workspaceGatewayHostHeader = "x-agents-in-the-cloud-gateway-host";
export const workspaceGatewayTokenHeader = "x-agents-in-the-cloud-gateway-token";
export const workspaceGatewayPortHeader = "x-agents-in-the-cloud-gateway-port";
export const workspaceGatewayProtocolHeader = "x-agents-in-the-cloud-gateway-protocol";

export const workspaceGatewayErrorHeader = "x-agents-in-the-cloud-gateway-error";

export function isWorkspaceAppPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535 && port !== workspaceGatewayPort;
}

const plainLoopbackHosts = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"];
const localhostSubdomainPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/;

export function localhostSubdomain(hostname: string): string | undefined {
  const normalized = hostname.toLowerCase();
  return localhostSubdomainPattern.test(normalized) ? normalized : undefined;
}

export function isWorkspaceLoopbackHost(hostname: string): boolean {
  return plainLoopbackHosts.includes(hostname.toLowerCase()) || localhostSubdomain(hostname) !== undefined;
}

export function workspacePortAppKey(port: number, hostname = "localhost"): string {
  if (!isWorkspaceLoopbackHost(hostname)) throw new Error(`Not a workspace loopback host: ${hostname}`);
  const subdomain = localhostSubdomain(hostname);
  return subdomain ? `port-${port}@${subdomain}` : `port-${port}`;
}

export function parseWorkspacePortAppKey(appKey: string): { port: number; host?: string } | undefined {
  const match = appKey.match(/^port-(\d+)(?:@(.+))?$/);
  if (!match || (match[2] !== undefined && localhostSubdomain(match[2]) !== match[2])) return undefined;
  return { port: Number(match[1]), host: match[2] };
}

export interface WorkspaceGateway {
  url: URL;
  token: string;
}
