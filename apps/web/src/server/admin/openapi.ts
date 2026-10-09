import type { JsonObject } from "@agents-in-the-cloud/core";
import type { TSchema } from "typebox";
import type { AdminRoute } from "./routes.ts";
import { bindingSchema, tokenInputSchema } from "./store.ts";

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
    for (const status of ["400", "401", "403", "404", "415", "500"]) responses[status] ??= { description: "Request rejected", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
    const operation = { ...original, summary: allowed.summary ?? original?.summary, responses, security: [{ adminToken: [] }], "x-admin-scopes-any-of": allowed.scopes };
    if (operation.parameters) operation.parameters = operation.parameters.filter(parameter => parameter.in === "path" || (parameter.in === "query" && ["force", "action"].includes(String(parameter.name))));
    operation.parameters ??= [...allowed.path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1]!, in: "path", required: true, schema: { type: "string" } }));
    if (allowed.method !== "GET") operation.requestBody ??= jsonBody({ type: "object", additionalProperties: false });
    if (allowed.path === "/workspaces" && allowed.method === "POST") operation.requestBody = jsonBody({ type: "object", additionalProperties: false, properties: {
      source: { oneOf: [{ type: "object", properties: { type: { const: "empty" } }, additionalProperties: false }, { type: "object", required: ["type", "workspaceTemplate"], properties: { type: { const: "workspace-template" }, workspaceTemplate: { type: "string" } }, additionalProperties: false }] },
      title: { type: "string" }, agent: { type: "object", additionalProperties: false, properties: { agentTypeId: { type: "string" }, model: { type: "string" }, thinkingLevel: { type: "string" } } },
    } });
    if (allowed.path === "/admin/bindings" && allowed.method === "PUT") operation.requestBody = jsonBody({ type: "object", required: ["bindings"], properties: { bindings: { type: "array", items: bindingSchema } }, additionalProperties: false });
    if (allowed.path === "/admin/tokens" && allowed.method === "POST") {
      operation.requestBody = jsonBody(tokenInputSchema);
      delete responses["200"];
      responses["201"] = { description: "Token metadata and bearer secret (returned once)", content: { "application/json": { schema: { type: "object", properties: { token: { type: "object" }, secret: { type: "string" } } } } } };
    }
    if (allowed.path === "/settings/access" && allowed.method === "POST") operation.requestBody = jsonBody({ type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["localhost", "tailscale"] } }, additionalProperties: false });
    if (allowed.path.endsWith("/ssh-keys") && allowed.method === "POST") operation.requestBody = jsonBody({ type: "object", required: ["privateKey"], properties: { privateKey: { type: "string", writeOnly: true }, name: { type: "string" } } });
    if (allowed.path.endsWith("/ssh-keys/{keyId}") && allowed.method === "POST") operation.requestBody = jsonBody({ type: "object", required: ["name"], properties: { name: { type: "string" } } });
    if (allowed.path.endsWith("/public-key")) responses["200"] = { description: "Derived SSH public key", content: { "application/json": { schema: { type: "object", properties: { publicKey: { type: "string" } } } } } };
    (paths[allowed.path] ??= {})[method] = operation;
  }
  return { ...spec, info: { ...spec.info, title: "AgentsInTheCloud authenticated admin API", description: "JSON-only management API. Bearer token required for every request; x-admin-scopes-any-of lists permitted scopes. Send {} for bodyless mutations. Forced workspace deletion also requires workspaces:force-delete. Binding changes require app restart." }, paths, components: { ...spec.components, securitySchemes: { adminToken: { type: "http", scheme: "bearer" } } }, security: [{ adminToken: [] }] };
}
