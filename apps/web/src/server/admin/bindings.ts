import { isJsonObject } from "@agents-in-the-cloud/core";
import { createAdminAudit, createAdminRateLimit, type AdminAuditEntry } from "./audit.ts";
import { stat } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { adminInputSchema } from "./schemas.ts";
import { adminRoutes, matchAdminRoute, type AdminRoute } from "./routes.ts";
import { publicToken, type AdminStore, type AdminToken } from "./store.ts";
import { adminOpenApi } from "./openapi.ts";

const maxBodyBytes = 1024 * 1024;
function problem(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: status === 401 ? { "www-authenticate": "Bearer" } : {} });
}
class RequestProblem extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
async function jsonPayload(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RequestProblem(415, "json_required", "Use Content-Type: application/json");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBodyBytes) { await reader.cancel(); throw new RequestProblem(413, "payload_too_large", "JSON payload exceeds 1 MiB"); }
      chunks.push(value);
    }
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestProblem(400, "invalid_arguments", "A valid JSON object is required"); }
  if (!isJsonObject(value)) throw new RequestProblem(400, "invalid_arguments", "A JSON object is required");
  return value;
}

/** Authenticates before any dispatch, and calls shared app handlers without browser ingress. */
export function createAdminHandler(options: {
  store: AdminStore; app: { fetch(request: Request): Promise<Response> }; auditPath: string;
  systemAvailable?: () => boolean;
  systemFetch?: (path: "/access" | "/status", request: Request) => Promise<Response>;
  reportError?: (error: Error) => void;
}) {
  const audit = createAdminAudit(options.auditPath);
  const permit = createAdminRateLimit();
  let lastErrorAt = 0;
  const rejected = new Map<number, { at: number; suppressed: number }>();
  function reportFailure() {
    if (Date.now() - lastErrorAt < 60_000) return;
    lastErrorAt = Date.now();
    (options.reportError ?? console.error)(new Error("Admin operation/audit unavailable; inspect local storage and management state"));
  }
  const systemFetch = options.systemFetch ?? ((path, request) => fetch(`http://127.0.0.1:3001${path}`, { method: request.method, headers: { "content-type": "application/json" }, body: request.body, signal: AbortSignal.timeout(15000) }));
  async function dispatch(request: Request, route: AdminRoute, token: AdminToken): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "GET" ? undefined : await jsonPayload(request);
    if (route.path === "/workspaces/{id}/delete" && (body?.force === true || url.searchParams.has("force")) && !token.scopes.includes("workspaces:force-delete")) return problem(403, "insufficient_scope", "Forced deletion requires workspaces:force-delete");
    if (route.path === "/workspaces" && request.method === "POST" && isJsonObject(body?.agent) && ("initialPrompt" in body.agent || "attachmentDraft" in body.agent)) return problem(403, "operation_not_allowed", "Agent prompting and attachments are not exposed on the admin API");
    if (body !== undefined && !Value.Check(adminInputSchema(route), body)) throw new RequestProblem(400, "invalid_arguments", "JSON payload does not match the documented operation schema");
    // Preserve only supported query parameters; never carry Turbo, cookies or forwarded headers.
    const target = new URL(url.pathname, "http://admin.internal");
    const queryKeys = route.path.endsWith("/park") ? ["force"] : route.path.endsWith("/provisioning/continue") ? ["action"] : [];
    for (const key of queryKeys) { const value = url.searchParams.get(key); if (value !== null) target.searchParams.set(key, value); }
    const forwarded = new Request(target, { method: request.method, headers: { accept: "application/json", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (route.path === "/admin/bindings") {
      if (request.method === "GET") return Response.json({ bindings: (await options.store.read()).bindings });
      if (!body || Object.keys(body).length !== 1 || !("bindings" in body)) throw new RequestProblem(400, "invalid_arguments", "Expected { bindings: [...] }");
      try { return Response.json(await options.store.setBindings(body.bindings)); }
      catch (error) { if (error instanceof Error && /Invalid admin bindings|bind host|require TLS|paths must|Duplicate admin/.test(error.message)) throw new RequestProblem(400, "invalid_arguments", error.message); throw error; }
    }
    if (route.path === "/admin/tokens") {
      if (request.method === "GET") return Response.json({ tokens: (await options.store.read()).tokens.map(publicToken) });
      try { return Response.json(await options.store.issue(body ?? null), { status: 201 }); }
      catch (error) { if (error instanceof Error && /Invalid token|Token expiry/.test(error.message)) throw new RequestProblem(400, "invalid_arguments", error.message); throw error; }
    }
    if (route.path === "/admin/tokens/{tokenId}") {
      const revoked = await options.store.revoke(decodeURIComponent(url.pathname.split("/").at(-1)!));
      return revoked ? Response.json({ revoked }) : problem(404, "token_not_found", "Token not found");
    }
    if (route.path === "/settings/access" || route.path === "/host/status") {
      if (!options.systemAvailable?.()) return problem(503, "system_unavailable", "This instance is not managed by System");
      if (body && (Object.keys(body).some(key => key !== "mode") || (body.mode !== "localhost" && body.mode !== "tailscale"))) throw new RequestProblem(400, "invalid_arguments", "Expected mode: localhost or tailscale");
      const result = await systemFetch(route.path === "/host/status" ? "/status" : "/access", forwarded);
      if (!result.ok) return problem(502, "system_request_failed", "System rejected the operation");
      const value = await result.json();
      if (route.path === "/host/status") return Response.json({ healthy: value.healthy, busy: value.busy, currentImage: value.currentImage, connectionState: value.connectionState, localOrigin: value.localOrigin, tailnetHost: value.tailnetHost });
      return Response.json({ mode: value.mode, connectionState: value.connectionState, origin: value.origin, authUrl: value.authUrl });
    }
    if (route.path === "/openapi.json") {
      const response = await options.app.fetch(forwarded);
      return Response.json(adminOpenApi(await response.json(), adminRoutes));
    }
    const response = await options.app.fetch(forwarded);
    if (route.path.endsWith("/public-key") && response.ok) return Response.json({ publicKey: await response.text() });
    if (response.status >= 500) {
      if (!response.headers.get("content-type")?.includes("application/json")) return problem(response.status, "operation_failed", "Management operation failed");
      const value = await response.json();
      const code = isJsonObject(value) && isJsonObject(value.error) && Value.Check(Type.String({ pattern: "^[a-z][a-z0-9_]{0,99}$" }), value.error.code) ? value.error.code : "operation_failed";
      return problem(response.status, code, "Management operation failed");
    }
    if (!response.headers.get("content-type")?.includes("application/json")) return problem(502, "non_json_response", "Operation did not provide a JSON response");
    return response;
  }
  return async (request: Request, peer?: string): Promise<Response> => {
    let token: AdminToken | undefined;
    let route: AdminRoute | undefined;
    let response: Response;
    const requestId = crypto.randomUUID();
    const entry: AdminAuditEntry = { requestId, tokenId: null, transportPeer: peer ?? null, method: request.method, operation: null, status: null, phase: "rejected" };
    let admitted = false;
    try {
      if (!permit(peer ?? "unknown")) response = problem(429, "rate_limited", "Admin request budget exceeded; retry after one minute");
      else {
        token = await options.store.authenticate(request.headers.get("authorization"));
        entry.tokenId = token?.id ?? null;
        if (!token) response = problem(401, "unauthorized", "A valid admin bearer token is required");
        else if (request.headers.has("upgrade")) response = problem(403, "operation_not_allowed", "WebSocket upgrades are not available on the admin API");
        else {
          const url = new URL(request.url);
          // Encoded delimiters must not cause authorization and app routing to disagree.
          if (/%(?:2f|5c|00|25)/i.test(url.pathname)) response = problem(400, "invalid_path", "Encoded path delimiters are not supported");
          else {
            route = matchAdminRoute(request.method, url.pathname);
            if (!route) response = problem(404, "operation_not_allowed", "Operation is not exposed on the admin API");
            else if (!route.scopes.some(scope => token!.scopes.includes(scope))) response = problem(403, "insufficient_scope", "Token does not permit this operation");
            else {
              entry.operation = route.path;
              entry.phase = "admitted";
              // Refuse to execute if the admission record cannot be written.
              try { await audit(entry); admitted = true; }
              catch { reportFailure(); throw new RequestProblem(503, "audit_unavailable", "Admin audit storage unavailable; operation not executed"); }
              response = await dispatch(request, route, token);
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof RequestProblem) response = problem(error.status, error.code, error.message);
      else { reportFailure(); response = problem(500, "admin_operation_failed", "Admin operation failed"); }
    }
    entry.status = response.status;
    entry.operation = route?.path ?? null;
    entry.phase = admitted ? "completed" : "rejected";
    let auditFailure = false;
    const previous = rejected.get(response.status);
    if (admitted || !previous || Date.now() - previous.at >= 60_000) {
      if (!admitted) { entry.suppressed = previous?.suppressed ?? 0; rejected.set(response.status, { at: Date.now(), suppressed: 0 }); }
      try { await audit(entry); }
      catch { auditFailure = true; reportFailure(); }
    } else previous.suppressed++;
    const headers = new Headers(response.headers);
    if (auditFailure) headers.set("x-admin-audit-warning", "completion-record-unavailable");
    if (response.status === 429) headers.set("retry-after", "60");
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  };
}

export async function startAdminBindings(options: Parameters<typeof createAdminHandler>[0]) {
  const bindings = (await options.store.read()).bindings;
  const handler = createAdminHandler(options);
  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    for (const binding of bindings) {
      if (binding.tls && ((await stat(binding.tls.key)).mode & 0o077) !== 0) throw new Error("Admin TLS private key must not have group/other permissions; use chmod 600");
      const tls = binding.tls ? { cert: await Bun.file(binding.tls.cert).text(), key: await Bun.file(binding.tls.key).text() } : undefined;
      servers.push(Bun.serve({ hostname: binding.host, port: binding.port, tls, maxRequestBodySize: maxBodyBytes * 2, fetch: (request, server) => handler(request, server.requestIP(request)?.address), error: () => problem(500, "admin_operation_failed", "Admin operation failed") }));
    }
  } catch (error) { for (const server of servers) server.stop(true); throw error; }
  return servers;
}


/** Optional API failures must not prevent the existing UI from starting. */
export async function startOptionalAdminBindings(options: Parameters<typeof createAdminHandler>[0]) {
  try { return await startAdminBindings(options); }
  catch (error) {
    (options.reportError ?? console.error)(new Error(`Admin listeners disabled: ${error instanceof Error ? error.message : "startup failed"}. Correct the local configuration and restart the app.`));
    return [];
  }
}
