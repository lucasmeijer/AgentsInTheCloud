import { disclosureHtml } from "@agents-in-the-cloud/design-system/disclosure";
import { hostDiagnosticGroups } from "../diagnostics.ts";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { requestAcceptsJson } from "@agents-in-the-cloud/core";
import { hostOpenApiPaths } from "./openapi.ts";
import { escapeHtml, type WorkspaceModule } from "@agents-in-the-cloud/shared";
import { response } from "@agents-in-the-cloud/shared/http";
import { hostAvailable, hostRequest } from "./connection.ts";
import type { HostSample } from "../protocol.ts";

const statsFrame = "host_stats";
const e = escapeHtml;
function failure(error: string): string {
  return `<div class="host-error" role="alert" data-controller="host-dismiss"><p>${e(error)}</p>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss host error" }, attributesHtml: 'data-action="host-dismiss#dismiss"' })}</div>`;
}
function sampleForm() {
  return `<form method="post" action="/host/sample" data-turbo-frame="${statsFrame}">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Sample" }, attributesHtml: 'data-turbo-submits-with="Sampling…"' })}</form>`;
}

function renderDiagnosticTable(sample: HostSample): string {
  const metrics = new Map(sample.metrics.map(metric => [metric.id, metric]));
  const groups = hostDiagnosticGroups.map(group => `<tbody>${group.rows.map((row, index) => {
    const metric = metrics.get(row.id);
    const attention = !metric || metric.warning;
    return `<tr>${index === 0 ? `<th class="host-resource" scope="rowgroup" rowspan="${group.rows.length}">${group.name}</th>` : ""}<th scope="row"><span>${row.label}</span> <span class="host-metric-context">${row.context}</span></th><td${attention ? ' class="host-reading-warning"' : ""}>${attention ? '<span class="status-dot warning" role="img" aria-label="Needs attention"></span>' : ""}<span>${metric ? e(metric.value) : "Unavailable"}</span></td></tr>`;
  }).join("")}</tbody>`).join("");
  return `<div class="host-table-wrap"><table class="host-diagnostics-table" aria-label="Host resource measurements"><thead><tr><th scope="col">Resource</th><th scope="col">Measurement</th><th scope="col">Reading</th></tr></thead>${groups}</table></div>`;
}

function renderSample(sample?: HostSample, error?: string): string {
  const unavailable = sample?.sections.filter(section => section.error).length ?? 0;
  const timestamp = sample ? `<time datetime="${e(sample.sampledAt)}" title="${e(new Date(sample.sampledAt).toLocaleString())}">${e(new Date(sample.sampledAt).toLocaleTimeString())}</time> · ${(sample.durationMs / 1000).toFixed(1)}s collection` : "Read-only snapshot · no background polling";
  const details = sample ? disclosureHtml({
    summary: { kind: "compact", label: { kind: "text", text: "Detailed diagnostics" }, trailingHtml: `<span>${sample.sections.length} probes${unavailable ? ` · <span class="host-reading-warning">${unavailable} unavailable</span>` : ""}</span>` },
    bodyHtml: `<div class="host-probes">${sample.sections.map(section => `<div class="host-probe">${disclosureHtml({
      summary: { kind: "multiline", label: { kind: "text", text: section.title }, trailingHtml: `<span class="${section.error ? "host-reading-warning" : "host-probe-state"}">${section.error ? '<span class="status-dot warning" aria-hidden="true"></span> Unavailable' : "Collected"}</span>` },
      bodyHtml: `<pre>${e(section.text)}</pre>`,
    })}</div>`).join("")}</div>`,
  }) : "";
  return `<turbo-frame id="${statsFrame}"><section class="host-stats"><header class="host-section-heading"><div><h3>Diagnostics</h3><p>${sample ? "Sampled " : ""}${timestamp}</p></div>${sampleForm()}</header>${error ? failure(error) : ""}${sample ? renderDiagnosticTable(sample) : ""}${details}</section></turbo-frame>`;
}

async function handle(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname !== "/host" && !url.pathname.startsWith("/host/")) return;
  const json = requestAcceptsJson(request);
  if (url.pathname === "/host" && request.method === "GET") {
    if (json) return Response.json({ available: hostAvailable(), url: "/host", boundary: "AgentsInTheCloud System" });
    return Response.redirect(new URL("/settings?section=host", url), 303);
  }
  if (!hostAvailable()) return json
    ? Response.json({ error: { code: "host_unavailable", message: "Host access requires AgentsInTheCloud System" } }, { status: 503 })
    : response("Host access requires AgentsInTheCloud System", { status: 503 });
  if (url.pathname !== "/host/sample" || !["GET", "POST"].includes(request.method)) return new Response("Not found", { status: 404 });
  try {
    const sample = await hostRequest({ operation: "sample", fresh: request.method === "POST" });
    return json ? Response.json(sample) : response(renderSample(sample));
  } catch (error) {
    const message = String(error);
    if (json) return Response.json({ error: { code: "host_sample_failed", message } }, { status: 502 });
    return response(renderSample(undefined, message));
  }
}
export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "host",
  settingsContributions: [{ id: "host", label: "Host", order: 80, render: async () => hostAvailable() ? `<div class="host-content"><turbo-frame id="${statsFrame}" src="/host/sample"><p role="status">Sampling host…</p></turbo-frame></div>` : `<p>Host access requires an AgentsInTheCloud System image with the host service. This instance has no Host connection.</p>` }],
  routes: [{ handle }],
  openApiPaths: hostOpenApiPaths,
  staticFiles: { "/host.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
};
