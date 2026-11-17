import {
  isWorkspaceAppPort,
  workspaceGatewayPortHeader,
  workspaceGatewayHostHeader,
  workspaceGatewayProtocolHeader,
  workspaceGatewayTokenHeader,
  type WorkspaceHttpAppBackend,
} from "@agents-in-the-cloud/shared";

export function backendTransport(backend: WorkspaceHttpAppBackend, headers: Headers) {
  headers = new Headers(headers);
  headers.delete(workspaceGatewayHostHeader);
  headers.delete(workspaceGatewayTokenHeader);
  headers.delete(workspaceGatewayPortHeader);
  headers.delete(workspaceGatewayProtocolHeader);
  headers.delete("proxy-authorization");
  if (!backend.gateway) return { target: backend.target, headers };

  const protocol = backend.target.protocol;
  const port = Number(backend.target.port || (protocol === "https:" ? 443 : 80));
  if (backend.target.hostname !== "127.0.0.1" || !isWorkspaceAppPort(port) || (protocol !== "http:" && protocol !== "https:")) {
    throw new Error("Workspace gateway requires a workspace-local HTTP or HTTPS target");
  }
  headers.set(workspaceGatewayHostHeader, headers.get("host") ?? backend.target.host);
  headers.set(workspaceGatewayTokenHeader, backend.gateway.token);
  headers.set(workspaceGatewayPortHeader, String(port));
  headers.set(workspaceGatewayProtocolHeader, protocol.slice(0, -1));
  const target = new URL(backend.gateway.url);
  target.pathname = backend.target.pathname;
  target.search = backend.target.search;
  return { target, headers, workspacePort: port };
}
