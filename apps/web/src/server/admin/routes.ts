import type { AdminScope } from "./store.ts";

export type AdminRoute = { path: string; method: "GET" | "POST" | "PUT" | "DELETE"; scopes: AdminScope[]; summary?: string };
// Explicit allowlist: never infer access from prefixes or expose new contributed routes automatically.
export const adminRoutes: AdminRoute[] = [];
function route(method: AdminRoute["method"], path: string, scopes: AdminScope[], summary?: string) { adminRoutes.push({ method, path, scopes, summary }); }
const discovery: AdminScope[] = ["configuration", "secrets", "security", "workspaces"];
route("GET", "/openapi.json", [...discovery, "host:read"], "Discover the authenticated admin API");
route("GET", "/agent-types", ["workspaces"]);
route("GET", "/workspace-templates", discovery);
route("POST", "/workspace-templates", ["configuration"]);
const template = "/workspace-templates/{workspaceTemplateId}";
route("GET", template, discovery);
route("POST", template, ["configuration"]);
const globalSettings = "/global-workspace-settings";
route("GET", globalSettings, discovery, "Inspect shared workspace environment, secret metadata and SSH configuration");
for (const prefix of [template, globalSettings]) {
  for (const suffix of ["environment", "environment/{variableId}", "environment/{variableId}/delete"]) route("POST", `${prefix}/${suffix}`, ["configuration"]);
  for (const suffix of ["secrets", "secrets/{secretId}", "secrets/{secretId}/delete"]) route("POST", `${prefix}/${suffix}`, ["secrets"]);
  for (const suffix of ["ssh-known-hosts", "ssh-keys", "ssh-keys/{keyId}", "ssh-keys/{keyId}/delete"]) route("POST", `${prefix}/${suffix}`, ["security"], `Manage ${prefix === globalSettings ? "shared" : "template"} SSH configuration`);
  route("GET", `${prefix}/ssh-known-hosts`, ["security"]);
  route("GET", `${prefix}/ssh-keys/{keyId}/public-key`, ["security"]);
}
for (const suffix of ["delete", "preload-images"]) route("POST", `${template}/${suffix}`, ["configuration"]);
for (const suffix of ["privileged", "seed-config", "dockerfile"]) route("POST", `${template}/${suffix}`, ["security"]);
route("GET", "/workspaces", ["workspaces"]);
route("POST", "/workspaces", ["workspaces"]);
route("GET", "/workspaces/{id}", ["workspaces"]);
for (const suffix of ["sidebar-title", "park", "unpark", "delete", "provisioning/continue", "warnings/{kind}/dismiss"]) route("POST", `/workspaces/{id}/${suffix}`, ["workspaces"]);
route("GET", "/host", ["host:read"]);
route("GET", "/host/sample", ["host:read"]);
route("POST", "/host/sample", ["host:read"]);
route("GET", "/host/status", ["host:read"], "Read bounded System status (without raw logs or terminal access)");
route("GET", "/settings/access", ["security"], "Read System localhost/Tailscale access configuration");
route("POST", "/settings/access", ["security"], "Change System localhost/Tailscale access configuration");
route("GET", "/admin/bindings", ["security"], "Read admin listener configuration");
route("PUT", "/admin/bindings", ["security"], "Configure admin listeners; app restart required");
route("GET", "/admin/tokens", ["security"], "List token metadata (never bearer secrets)");
route("POST", "/admin/tokens", ["security"], "Issue an admin token; bearer secret returned once");
route("DELETE", "/admin/tokens/{tokenId}", ["security"], "Revoke an admin token immediately");

route("GET", "/settings/release-source", ["security"], "Read the installation release repositories and pins");
route("POST", "/settings/release-source", ["security"], "Configure app and System release repositories and pins");
route("POST", "/settings/update-channel", ["security"], "Select Stable or Latest for unpinned releases");
route("GET", "/settings/release-registry", ["security"], "Read registry credential availability (never credentials)");
route("POST", "/settings/release-registry", ["security"], "Store private GHCR package read credentials in System");
route("DELETE", "/settings/release-registry", ["security"], "Remove private GHCR credentials");
route("GET", "/update/status", ["security"], "Read app update status");
for (const suffix of ["check-now", "start", "restart", "rollback"]) route("POST", `/update/${suffix}`, ["security"], "Control the configured app update");

export function matchAdminRoute(method: string, pathname: string): AdminRoute | undefined {
  if (["/workspaces/new", "/workspace-templates/new", "/workspace-templates/github-search"].includes(pathname)) return undefined;
  const segments = pathname.split("/");
  return adminRoutes.find(route => {
    const pattern = route.path.split("/");
    return route.method === method && pattern.length === segments.length && pattern.every((segment, index) => /^\{[^}]+\}$/.test(segment) ? Boolean(segments[index]) : segment === segments[index]);
  });
}
