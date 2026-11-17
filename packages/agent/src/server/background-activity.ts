import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { disclosureHtml } from "@agents-in-the-cloud/design-system/disclosure";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { invalidArguments } from "@agents-in-the-cloud/core";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { response } from "@agents-in-the-cloud/shared/http";
import { renderTranscript, renderTranscriptItemDetailFrame } from "./render-transcript.ts";
import { scriptSourceRegion } from "./render-tool.ts";
import { formatWorkflowScriptForDisplay } from "./embedded-code.ts";
import { findTranscriptItem, type TranscriptItem } from "./transcript.ts";
import { backgroundActivityPath, ids, type AgentRenderContext } from "./render-context.ts";
import { transcriptTargetLink } from "./render-markup.ts";

export interface BackgroundActivity {
  key: string;
  kind: string;
  title: string;
  running: boolean;
  startedAt?: number;
  progress?: string;
  result?: string;
  details: Record<string, string>;
  startedBy?: { itemKey: string; label: string };
  parentKey?: string;
  stoppable: boolean;
  opens: "inline" | "drill-in";
}

function ordered(activities: readonly BackgroundActivity[]): Array<{ activity: BackgroundActivity; depth: number }> {
  const keys = new Set(activities.map(activity => activity.key));
  const children = (parent: BackgroundActivity, depth: number): Array<{ activity: BackgroundActivity; depth: number }> => [{ activity: parent, depth }, ...activities.filter(child => child.parentKey === parent.key).flatMap(child => children(child, depth + 1))];
  const roots = activities.filter(activity => !activity.parentKey || !keys.has(activity.parentKey));
  return [...roots.filter(activity => activity.running), ...roots.filter(activity => !activity.running)].flatMap(root => children(root, 0));
}

const spinnerHtml = '<span class="status-indicator" role="img" aria-label="Running"><i class="status-spinner sm" aria-hidden="true"></i></span>';

function rowHtml(ctx: AgentRenderContext, activity: BackgroundActivity, depth: number, withResult = false): string {
  const path = backgroundActivityPath(ctx, activity.key);
  const label = { kind: "text" as const, text: activity.title };
  const spinner = activity.running ? spinnerHtml : "";
  const result = withResult && activity.result ? `<span class="agent-background-result" title="${escapeHtml(activity.result)}">${escapeHtml(activity.result)}</span>` : "";
  const row = activity.opens === "drill-in"
    ? contentRowHtml({ kind: "compact", width: "fill", label, trailingHtml: `${result}${spinner}<span class="agent-background-chevron">${Icons.Next}</span>`, element: { tag: "a", attributesHtml: `href="${escapeHtml(path)}" data-action="agent-background#open"` } })
    : disclosureHtml({ summary: { kind: "compact", width: "fill", label, trailingHtml: spinner }, bodyHtml: `<turbo-frame id="${ids.backgroundDetail(ctx, activity.key)}" src="${escapeHtml(path)}" loading="lazy" refresh="morph" data-turbo-permanent></turbo-frame>` });
  return `<div class="agent-background-activity${result ? " agent-background-activity--result" : ""}" style="--agent-background-depth: ${depth}" data-background-key="${escapeHtml(activity.key)}">${row}</div>`;
}

export function backgroundActivityLinksHtml(ctx: AgentRenderContext, activities: readonly BackgroundActivity[]): string {
  return activities.map(activity => {
    if (activity.opens !== "drill-in") throw new Error("Only drill-in activities link from a page");
    return rowHtml(ctx, activity, 0, true);
  }).join("");
}

export function renderBackgroundActivities(ctx: AgentRenderContext, activities: readonly BackgroundActivity[]): string {
  if (!activities.length) return "";
  const running = activities.filter(activity => activity.running).length;
  const inactive = activities.length - running;
  const count = [running ? `${running} running ${spinnerHtml}` : "", inactive ? `${inactive} inactive` : ""].filter(Boolean).join(" · ");
  const html = ordered(activities).map(({ activity, depth }) => rowHtml(ctx, activity, depth)).join("");
  return disclosureHtml({
    element: { id: ids.backgroundList(ctx) },
    summary: { kind: "compact", width: "fill", label: { kind: "text", text: "Background" }, trailingHtml: `<span class="agent-background-meta">${count}</span>` },
    bodyHtml: html,
  });
}

function stopHtml(ctx: AgentRenderContext, activity: BackgroundActivity): string {
  if (!activity.stoppable || !activity.running) return "";
  return `<form method="post" action="${escapeHtml(backgroundActivityPath(ctx, activity.key, "/stop"))}" class="agent-background-stop">${destructiveConfirmationHtml({
    id: `${ids.backgroundDetail(ctx, activity.key)}_stop`,
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Stop" } },
    confirmCaption: `Stop ${activity.kind}`,
    cancelCaption: "Keep running",
  })}</form>`;
}

export function refreshingBackgroundDetail(activity: BackgroundActivity, html: string): string {
  return `<div${activity.running ? ' data-controller="agent-background-refresh"' : ""}>${html}</div>`;
}

function factsHtml(ctx: AgentRenderContext, activity: BackgroundActivity): string {
  const facts: Array<[string, string]> = [["Kind", escapeHtml(activity.kind)]];
  if (activity.running && activity.startedAt !== undefined) facts.push(["Running for", `<span data-controller="agent-elapsed" data-agent-elapsed-since-value="${activity.startedAt}" data-agent-elapsed-format-value="duration"><span data-agent-elapsed-target="time"></span></span>`]);
  if (activity.startedBy) facts.push(["Started by", transcriptTargetLink(ctx, activity.startedBy.itemKey, activity.startedBy.label)]);
  if (activity.progress) facts.push(["Progress", escapeHtml(activity.progress)]);
  for (const [label, text] of Object.entries(activity.details)) facts.push([escapeHtml(label), escapeHtml(text)]);
  return `<dl class="agent-background-facts">${facts.map(([label, html]) => `<dt>${label}</dt><dd>${html}</dd>`).join("")}</dl>`;
}

export function renderBackgroundInlineDetail(ctx: AgentRenderContext, activity: BackgroundActivity, detailHtml: string): string {
  return `<turbo-frame id="${ids.backgroundDetail(ctx, activity.key)}" refresh="morph"><div class="agent-background-detail">${factsHtml(ctx, activity)}${stopHtml(ctx, activity)}${detailHtml}</div></turbo-frame>`;
}

const backHtml = buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Back, label: "Back" }, attributesHtml: 'data-action="agent-background#back"' });

export function renderBackgroundPage(ctx: AgentRenderContext, activity: BackgroundActivity, detailHtml: string): string {
  return `<turbo-frame id="${ids.backgroundPage(ctx)}" refresh="morph"><div class="agent-background-page-content">
    <header class="agent-background-page-header">
      <div class="agent-background-page-heading">${backHtml}<h2 class="agent-background-page-title">${escapeHtml(activity.title)}${activity.running ? spinnerHtml : ""}</h2>${stopHtml(ctx, activity)}</div>
      ${factsHtml(ctx, activity)}
    </header>
    <div class="agent-background-page-body">${detailHtml}</div>
  </div></turbo-frame>`;
}

function backgroundTranscriptContext(ctx: AgentRenderContext, activity: BackgroundActivity): AgentRenderContext {
  return { ...ctx, transcriptBasePath: backgroundActivityPath(ctx, activity.key) };
}

export function backgroundTranscriptHtml(ctx: AgentRenderContext, activity: BackgroundActivity, items: TranscriptItem[]): string {
  return `<div class="agent-transcript-content">${renderTranscript(backgroundTranscriptContext(ctx, activity), items, { systemPrompt: "", tools: [] })}</div>`;
}

export async function backgroundTranscriptItemResponse(ctx: AgentRenderContext, activity: BackgroundActivity, path: string, url: URL, items: () => Promise<TranscriptItem[]>): Promise<Response | undefined> {
  if (!path.startsWith("transcript-items/")) return undefined;
  const item = findTranscriptItem(await items(), decodeURIComponent(path.slice("transcript-items/".length)));
  if (!item) return new Response("Transcript item not found", { status: 404 });
  const count = Number(url.searchParams.get("count") ?? 100);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw invalidArguments("Invalid transcript detail size");
  return response(renderTranscriptItemDetailFrame(backgroundTranscriptContext(ctx, activity), item, { count }));
}

export function backgroundReportHtml(ctx: AgentRenderContext, itemKey: string): string {
  return `<div class="agent-row agent-background-report">${transcriptTargetLink(ctx, itemKey, "The above final message was sent back into the parent conversation here")}</div>`;
}

export function backgroundOutputHtml(text: string, header = "Output"): string {
  return `<div class="agent-tool-detail"><section class="agent-tool-region"><div class="agent-region-header">${escapeHtml(header)}</div><pre class="agent-tool-result agent-tool-region-body">${escapeHtml(text || "(no output yet)")}</pre></section></div>`;
}

const scriptFrameId = (ctx: AgentRenderContext, activity: BackgroundActivity) => `${ids.backgroundDetail(ctx, activity.key)}_script`;

export function backgroundScriptFrameHtml(ctx: AgentRenderContext, activity: BackgroundActivity): string {
  return `<turbo-frame class="agent-background-script-frame" id="${scriptFrameId(ctx, activity)}" src="${escapeHtml(backgroundActivityPath(ctx, activity.key, "/script"))}" loading="lazy" data-turbo-permanent></turbo-frame>`;
}

export function backgroundScriptResponse(ctx: AgentRenderContext, activity: BackgroundActivity, script: string, collapsedLabel?: string): Response {
  const region = `<div class="agent-tool-detail">${scriptSourceRegion(script, formatWorkflowScriptForDisplay(script))}</div>`;
  const html = collapsedLabel ? disclosureHtml({ summary: { kind: "compact", width: "fill", label: { kind: "text", text: collapsedLabel } }, bodyHtml: region }) : region;
  return response(`<turbo-frame id="${scriptFrameId(ctx, activity)}">${html}</turbo-frame>`);
}

export function renderBackgroundGone(ctx: AgentRenderContext, key: string, page: boolean): string {
  const message = '<p class="agent-background-gone">This has finished. Its report is in the conversation.</p>';
  if (!page) return `<turbo-frame id="${ids.backgroundDetail(ctx, key)}">${message}</turbo-frame>`;
  return `<turbo-frame id="${ids.backgroundPage(ctx)}" refresh="morph"><div class="agent-background-page-content"><header class="agent-background-page-header"><div class="agent-background-page-heading">${backHtml}</div></header><div class="agent-background-page-body">${message}</div></div></turbo-frame>`;
}
