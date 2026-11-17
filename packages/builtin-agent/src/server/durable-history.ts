import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { actionLinkHtml } from "@agents-in-the-cloud/design-system/action-link";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { response } from "@agents-in-the-cloud/shared/http";
import { AgentsInTheCloudCoreError, getAgentsInTheCloudRuntimeContext, isNotFoundError } from "@agents-in-the-cloud/core";
import { sessionShareDir, workspaceSessionShareKey } from "@agents-in-the-cloud/agent/server/session-share";
import { durableJournalDirectory } from "./durable-storage.ts";
import { retainedDurableWorkspaceOwner } from "./runtime.ts";
import { projectDurableTranscript } from "./durable-transcript.ts";
import { findTranscriptItem } from "@agents-in-the-cloud/agent/server/transcript";
import { renderTranscriptItem, renderTranscriptItemDetailFrame } from "@agents-in-the-cloud/agent/server/render-transcript";
import { type AgentRouteHandler } from "./route-support.ts";
import type { DurableAgentRuntime } from "./durable-runtime.ts";

export async function retainedDurableHistories(workspaceId: string) {
  durableJournalDirectory("projectless", workspaceId);
  // A missing init is valid for an existing projectless workspace, but an
  // arbitrary/missing viewer must not turn into access to the projectless share.
  // Check retained host metadata only: history must work without Docker/readiness.
  const metadata = await stat(join(getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "workspaces", workspaceId, "metadata")).catch((error: NodeJS.ErrnoException) => {
    if (isNotFoundError(error)) return undefined;
    throw error;
  });
  if (!metadata?.isDirectory()) throw new AgentsInTheCloudCoreError("workspace_not_found", `workspace not found: ${workspaceId}`);
  const share = await workspaceSessionShareKey(workspaceId);
  const directory = join(sessionShareDir(share), "builtin-durable");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  const histories: { workspaceId: string; owner: DurableAgentRuntime }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = durableJournalDirectory(share, entry.name);
    if (!await Bun.file(join(path, "main.jsonl")).exists()) continue;
    histories.push({ workspaceId: entry.name, owner: await retainedDurableWorkspaceOwner(path, entry.name) });
  }
  return histories;
}

export const handleDurableHistoryRequest: AgentRouteHandler = async (request, url, options) => {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agent-history(?:\/([^/]+)\/([^/]+)(?:\/(session-images|transcript-items)\/([^/]+)(?:\/(\d+))?)?)?$/);
  if (!match || request.method !== "GET") return undefined;
  function page(title: string, content: string) {
    if (!options.renderPage) throw new Error("Native history requires the host page renderer");
    const rendered = options.renderPage(`<div class="app no-sidebar"><div class="main"><header class="header"><h1>${escapeHtml(title)}</h1></header><main class="body">${content}</main></div></div>`);
    rendered.headers.set("Cache-Control", "no-store");
    return rendered;
  }
  const viewer = decodeURIComponent(match[1]!);
  const [source = "", agentId = "", operation = "", item = "", index = ""] = match.slice(2).map(value => value === undefined ? "" : decodeURIComponent(value));
  const base = `/workspaces/${encodeURIComponent(viewer)}/agent-history`;
  const histories = await retainedDurableHistories(viewer);
  if (!source) {
    const rows: string[] = [];
    for (const history of histories) {
      const gates = await history.owner.admission();
      for (const record of await history.owner.catalog()) {
        const state = gates?.deleted ? "Deleted workspace" : gates?.closed.includes(record.durableId) ? "Closed conversation" : "Conversation";
        rows.push(contentRowHtml({ width: "fill", kind: "multiline", label: { kind: "text", text: record.title }, description: `${history.workspaceId} · ${record.label} · ${state}`, element: { tag: "a", attributesHtml: `href="${base}/${encodeURIComponent(history.workspaceId)}/${encodeURIComponent(record.agentId)}"` } }));
      }
    }
    return page("Agent history", `<p>Read-only history from this template's session share.</p><div class="action-list">${rows.join("") || "No native history yet."}</div>`);
  }
  const history = histories.find(history => history.workspaceId === source);
  const record = history && (await history.owner.catalog()).find(record => record.agentId === agentId);
  if (!history || !record) return response("Not found", { status: 404 });
  const controller = await history.owner.agent(record);
  if (operation === "session-images") return controller.image(item, Number(index));
  const branch = url.searchParams.get("branch") ?? String(record.durableId);
  if (!(record.branches ?? [record.durableId]).some(id => String(id) === branch)) return response("Not found", { status: 404 });
  const ctx = { workspaceId: source, agentId, readOnly: true, transcriptQuery: `branch=${encodeURIComponent(branch)}`, transcriptBasePath: `${base}/${encodeURIComponent(source)}/${encodeURIComponent(agentId)}` };
  const view = await controller.historyView(branch);
  const items = projectDurableTranscript(view);
  if (operation === "transcript-items") {
    const selected = findTranscriptItem(items, item);
    const count = Math.max(100, Math.min(100_000, Number(url.searchParams.get("count") ?? 100) || 100));
    return selected ? response(renderTranscriptItemDetailFrame(ctx, selected, { count })) : response("Not found", { status: 404 });
  }
  const branches = (record.branches ?? [record.durableId]).map(id => actionLinkHtml({ href: `${ctx.transcriptBasePath}?branch=${id}`, variant: "secondary", content: { kind: "caption", caption: `Branch ${id}${id === record.durableId ? " (current)" : ""}` } })).join(" ");
  return page(record.title, `${actionLinkHtml({ href: base, variant: "secondary", content: { kind: "caption", caption: "All history" } })}<nav>${branches}</nav><p>Full branch history, including earlier sessions. This view is read-only.</p><div class="agent-transcript"><div class="agent-transcript-content">${items.map(item => renderTranscriptItem(ctx, item)).join("")}</div></div>`);
};
