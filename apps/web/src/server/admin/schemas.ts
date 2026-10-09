import { releaseSourceSchema, registryCredentialSchema } from "@agents-in-the-cloud/shared/release-source";
import { Type, type TSchema } from "typebox";
import type { AdminRoute } from "./routes.ts";
import { bindingSchema, tokenInputSchema } from "./store.ts";

const empty = Type.Object({}, { additionalProperties: false });
const object = (properties: Parameters<typeof Type.Object>[0]) => Type.Object(properties, { additionalProperties: false });
const string = Type.String();
const secret = object({ envName: string, hostPattern: string, placeholder: Type.Optional(string), allowInPath: Type.Optional(Type.Boolean()), annotation: Type.Optional(string), secretValue: Type.Optional(Type.String({ writeOnly: true })) });
export const workspaceCreateSchema = object({
  source: Type.Optional(Type.Union([object({ type: Type.Optional(Type.Literal("empty")) }), object({ type: Type.Literal("workspace-template"), workspaceTemplate: string })])),
  title: Type.Optional(string),
  agent: Type.Optional(object({ agentTypeId: Type.Optional(string), model: Type.Optional(string), thinkingLevel: Type.Optional(string) })),
});

/** Runtime validation and OpenAPI share exactly the same mutation contracts. */
export function adminInputSchema(route: AdminRoute): TSchema {
  const path = route.path;
  if (path === "/settings/release-source") return releaseSourceSchema;
  if (path === "/settings/release-registry" && route.method === "POST") return registryCredentialSchema;
  if (path === "/settings/update-channel") return object({ channel: Type.Union([Type.Literal("stable"), Type.Literal("latest")]) });
  if (path === "/workspaces" && route.method === "POST") return workspaceCreateSchema;
  if (path === "/workspace-templates" && route.method === "POST") return object({ gitUrl: string });
  if (path === "/workspace-templates/{workspaceTemplateId}" && route.method === "POST") return object({ name: string, gitUrl: string, swatchColor: Type.Optional(Type.String({ pattern: "^(#[0-9a-fA-F]{6})?$" })) });
  if (path.endsWith("/environment") || path.endsWith("/environment/{variableId}")) return object({ name: string, value: string });
  if (path.endsWith("/secrets") || path.endsWith("/secrets/{secretId}")) return secret;
  if (path.endsWith("/preload-images")) return object({ preloadImages: Type.Array(string) });
  if (path.endsWith("/privileged")) return object({ privileged: Type.Boolean() });
  if (path.endsWith("/seed-config")) return object({ seedConfigEnabled: Type.Boolean() });
  if (path.endsWith("/dockerfile")) return object({ dockerfile: string });
  if (path.endsWith("/ssh-known-hosts")) return object({ knownHosts: string });
  if (path.endsWith("/ssh-keys")) return object({ privateKey: Type.String({ writeOnly: true }), name: Type.Optional(string) });
  if (path.endsWith("/ssh-keys/{keyId}")) return object({ name: string });
  if (path.endsWith("/sidebar-title")) return object({ title: string });
  if (path.endsWith("/warnings/{kind}/dismiss")) return object({ state: string });
  if (path === "/workspaces/{id}/delete") return object({ force: Type.Optional(Type.Boolean()) });
  if (path === "/admin/bindings") return object({ bindings: Type.Array(bindingSchema) });
  if (path === "/admin/tokens") return tokenInputSchema;
  if (path === "/settings/access") return object({ mode: Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")]) });
  return empty;
}
