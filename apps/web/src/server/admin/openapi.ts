import type { JsonObject } from "@agents-in-the-cloud/core";
import type { TSchema } from "typebox";
import type { AdminRoute } from "./routes.ts";
import { adminInputSchema } from "./schemas.ts";

type MediaType = { schema: TSchema | JsonObject };
type Operation = { summary?: string; description?: string; parameters?: JsonObject[]; requestBody?: { required?: boolean; content: Record<string, MediaType> }; responses?: Record<string, { description: string; content?: Record<string, MediaType> }>; security?: JsonObject[]; "x-admin-scopes-any-of"?: string[] };
type SourceSpec = { openapi: string; info: JsonObject; paths: Record<string, Record<string, Operation>>; components: JsonObject };
const jsonBody = (schema: TSchema | JsonObject) => ({ required: true, content: { "application/json": { schema } } });

export function adminOpenApi(source: SourceSpec, routes: AdminRoute[]) {
  const spec = structuredClone(source);
  const paths: Record<string, Record<string, Operation>> = {};
  for (const allowed of routes) {
    const method = allowed.method.toLowerCase();
    const original = spec.paths[allowed.path]?.[method];
    const responses: NonNullable<Operation["responses"]> = {};
    for (const [status, response] of Object.entries(original?.responses ?? {})) {
      responses[status] = { ...response, content: response.content?.["application/json"] ? { "application/json": response.content["application/json"] } : { "application/json": { schema: { type: "object" } } } };
    }
    if (!responses["200"] && !responses["202"]) responses["200"] = { description: "JSON operation result", content: { "application/json": { schema: { type: "object" } } } };
    for (const status of ["400", "401", "403", "404", "413", "415", "429", "500", "503"]) responses[status] ??= { description: "Request rejected", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
    const operation = { ...original, summary: allowed.summary ?? original?.summary, responses, security: [{ adminToken: [] }], "x-admin-scopes-any-of": allowed.scopes };
    if (operation.parameters) operation.parameters = operation.parameters.filter(parameter => parameter.in === "path" || (parameter.in === "query" && ["force", "action"].includes(String(parameter.name))));
    operation.parameters ??= [...allowed.path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1]!, in: "path", required: true, schema: { type: "string" } }));
    if (allowed.method !== "GET") operation.requestBody = jsonBody(adminInputSchema(allowed));
    if (allowed.path === "/admin/tokens" && allowed.method === "POST") {
      delete responses["200"];
      responses["201"] = { description: "Token metadata and bearer secret (returned once)", content: { "application/json": { schema: { type: "object", properties: { token: { type: "object" }, secret: { type: "string" } } } } } };
    }
    if (allowed.path === "/settings/access") responses["200"] = { description: "System access and Tailscale sign-in state", content: { "application/json": { schema: { type: "object", properties: { mode: { type: "string" }, connectionState: { type: "string" }, origin: { type: "string" }, authUrl: { type: "string", description: "Sensitive one-time Tailscale sign-in URL; security scope only" } } } } } };
    if (allowed.path.endsWith("/public-key")) responses["200"] = { description: "Derived SSH public key", content: { "application/json": { schema: { type: "object", properties: { publicKey: { type: "string" } } } } } };
    (paths[allowed.path] ??= {})[method] = operation;
  }
  return { ...spec, info: { ...spec.info, title: "AgentsInTheCloud authenticated admin API", description: "JSON-only management API. Bearer token required for every request; x-admin-scopes-any-of lists permitted scopes. Send {} for bodyless mutations. Forced workspace deletion also requires workspaces:force-delete. Binding changes require app restart." }, paths, components: { ...spec.components, securitySchemes: { adminToken: { type: "http", scheme: "bearer" } } }, security: [{ adminToken: [] }] };
}
