import { existsSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { toggleHtml } from "@agents-in-the-cloud/design-system/toggle";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { actionLinkHtml } from "@agents-in-the-cloud/design-system/action-link";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { agentsInTheCloudUrlHtml } from "../agents-in-the-cloud-url.ts";
import { response } from "@agents-in-the-cloud/shared/http";

export const connectionModeManaged = () => existsSync("/run/agents-in-the-cloud-system/access-v1");
const schema = Type.Object({ mode: Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")]), connectionState: Type.String(), authUrl: Type.Optional(Type.String()), origin: Type.Optional(Type.String()), error: Type.Optional(Type.String()) });
export async function renderConnectionModeSettings(): Promise<string> {
  if (!connectionModeManaged()) return "";
  const status = await fetch("http://127.0.0.1:3001/access");
  if (!status.ok) throw new Error(`System access status: ${status.status}`);
  const access = Value.Parse(schema, await status.json());
  const remote = access.mode === "tailscale";
  const modeToggle = toggleHtml({
    variant: "button",
    label: "Where can you use AgentsInTheCloud?",
    name: "mode",
    value: access.mode,
    form: { action: "/settings/access" },
    options: [
      { value: "localhost", label: "Installation computer only" },
      { value: "tailscale", label: "Devices on your Tailscale network" },
    ],
  });
  const connected = remote && access.connectionState === "Running";
  const connectionAction = !remote || connected ? "" : access.authUrl
    ? actionLinkHtml({ href: access.authUrl, variant: "primary", content: { kind: "caption", caption: "Sign in to Tailscale" }, attributesHtml: 'target="_blank" rel="noreferrer"' })
    : `<form action="/settings/access" method="post"><input type="hidden" name="mode" value="tailscale">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Retry Tailscale connection" } })}</form>`;
  return `<turbo-frame id="settings_access" data-controller="connection-mode-settings">
    <section class="settings-sec" id="settings-sec-access">
      <div class="settings-choice-row"><h2>Where can you use AgentsInTheCloud?</h2>${modeToggle}</div>
      ${!remote ? "<p>Use AgentsInTheCloud and Workspace previews in a browser on the computer where AgentsInTheCloud is installed. Tailscale is off.</p>" : ""}
      ${remote && !connected ? "<p>Tailscale isn’t connected yet.</p>" : ""}
      ${access.error ? `<p class="settings-error">${escapeHtml(access.error)}</p>` : ""}
      ${connectionAction}
    </section>
    <section class="settings-sec settings-sec-url" id="settings-sec-url"><h2>AgentsInTheCloud URL</h2>${access.origin ? agentsInTheCloudUrlHtml(access.origin, "settings_agents_in_the_cloud_url_qr") : '<p>The URL will appear when the connection is ready.</p>'}</section>
  </turbo-frame>`;
}
export async function handleConnectionModeSettings(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/settings/access")) return;
  if (!connectionModeManaged()) return new Response("System access settings are unavailable", { status: 404 });
  if (url.pathname === "/settings/access/events" && request.method === "GET") {
    const upstream = await fetch("http://127.0.0.1:3001/events", { signal: request.signal });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  if (url.pathname !== "/settings/access") return;
  if (request.method === "POST") {
    const mode = (await request.formData()).get("mode");
    if (mode !== "localhost" && mode !== "tailscale") return new Response("Invalid access mode", { status: 400 });
    const result = await fetch("http://127.0.0.1:3001/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    if (!result.ok) throw new Error(`System access setting: ${result.status}: ${await result.text()}`);
    return Response.redirect(new URL("/settings/access", url), 303);
  }
  if (request.method === "GET") return response(await renderConnectionModeSettings());
}
