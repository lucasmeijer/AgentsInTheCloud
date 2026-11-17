import { errorMessage, type WorkspaceAppRef } from "@agents-in-the-cloud/shared";

export class UnknownWorkspaceAppError extends Error {
  constructor(public readonly app: WorkspaceAppRef) {
    super(`unknown workspace app: ${app.appKey}`);
    this.name = "UnknownWorkspaceAppError";
  }
}

export class StoppedWorkspaceError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`Workspace ${workspaceId} is stopped. Start the workspace and try again.`);
    this.name = "StoppedWorkspaceError";
  }
}

export class WorkspaceUpstreamError extends Error {
  constructor(message: string, public readonly port: number) {
    super(message);
    this.name = "WorkspaceUpstreamError";
  }
}

export class WorkspaceConnectionError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "WorkspaceConnectionError";
  }
}

export class WorkspaceAuthenticationError extends Error {
  constructor() {
    super("AgentsInTheCloud’s workspace connection credentials were rejected");
    this.name = "WorkspaceAuthenticationError";
  }
}

export function errorCategory(error: Error) {
  if (error instanceof WorkspaceAuthenticationError) return "workspace_authentication";
  if (error instanceof UnknownWorkspaceAppError) return "unknown_app";
  if (error instanceof StoppedWorkspaceError) return "stopped_workspace";
  const message = error.message;
  if (/workspace.*not found|no such container/i.test(message)) return "unknown_workspace";
  if (/unsupported workspace preview port|ineligible port|not published for browser previews/i.test(message)) return "ineligible_port";
  if (/capacity exhausted|no browser origins available/i.test(message)) return "capacity_exhausted";
  if (/Workspace ingress is stopping/i.test(message)) return "service_stopping";
  if (/another process is using it/i.test(message)) return "origin_conflict";
  if (/already published with a different protocol/i.test(message)) return "protocol_conflict";
  if (/tls|certificate|x509|https client/i.test(message)) return "tls_failure";
  if (/ECONNRESET|connection reset|unexpected EOF|\bEOF\b|socket closed/i.test(message)) return "connection_closed";
  if (/ECONNREFUSED|connection refused|Unable to connect|connection failed/i.test(message)) return "connection_refused";
  if (/timeout|timed out/i.test(message)) return "connection_timeout";
  if (/does not support WebSockets|unsupported target/i.test(message)) return "unsupported_target";
  if (/invalid HTTP|malformed/i.test(message)) return "malformed_upstream";
  return "routing_failure";
}

