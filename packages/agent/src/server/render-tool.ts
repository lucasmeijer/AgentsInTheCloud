import { disclosureHtml } from "@agents-in-the-cloud/design-system/disclosure";
import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { agentToolPresentations } from "./tool-presentations.ts";
import { copyButtonHtml } from "@agents-in-the-cloud/design-system/copy-button";
import { buttonGroupHtml } from "@agents-in-the-cloud/design-system/button-group";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { dialogHtml } from "@agents-in-the-cloud/design-system/dialog";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { toggleHtml } from "@agents-in-the-cloud/design-system/toggle";
import { isJsonObject, type JsonObject } from "@agents-in-the-cloud/core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { parseDiffFromFile, processPatch, type FileDiffMetadata } from "@pierre/diffs";
import { diffStats, type DiffOperation } from "./diff.ts";
import { embeddedBashCommand, formatBashCommandForDisplay, highlightedBashCommandHtml } from "./embedded-code.ts";
import { domId, escapeHtml } from "@agents-in-the-cloud/shared";
import { isBashTool, formatDuration, type ToolView } from "./transcript.ts";
import { agentPath, ids, sessionImageUrl, transcriptItemPath, type AgentRenderContext } from "./render-context.ts";
import { codeBlockHtml, detailFullscreen, fullscreenAttributes, transcriptRowContent } from "./render-markup.ts";

type ToolArgumentKey = "command" | "path" | "file_path" | "content" | "offset" | "limit" | "timeout" | "edits" | "oldText" | "newText";

const toolStringArgumentSchema = Type.String();
const toolNumberArgumentSchema = Type.Number();
const diffOperationSchema = Type.Object({
  oldText: Type.String(),
  newText: Type.String(),
});

function statusHtml(status: ToolView["status"], readOnly = false): string {
  const state = status === "streaming" || status === "running" ? "running" : status === "error" ? "danger" : "success";
  return `<span class="status-dot ${state}${state === "running" && readOnly ? " static" : ""}" aria-label="${state === "running" ? "In progress" : state === "danger" ? "Failed" : "Complete"}"></span>`;
}

function summaryHtml(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function bashSummary(tool: ToolView): string {
  const details = tool.details;
  const timeout = numberArg(toolArgs(tool), "timeout") ?? 600;
  const elapsed = tool.status === "running" && tool.issuedAt !== undefined ? Date.now() - tool.issuedAt : tool.durationMs;
  const duration = elapsed === undefined ? "" : `${formatDuration(elapsed)} / ${formatDuration(timeout * 1000)}`;
  const outcome = details?.timedOut === true ? "timed out" : details?.aborted === true ? "aborted" : details?.exitCode !== undefined && details.exitCode !== 0 ? `exitcode ${details.exitCode}` : "";
  return summaryHtml([duration, outcome]);
}

function toolSummaryHtml(tool: ToolView): string {
  if (isBashTool(tool.name)) return bashSummary(tool);
  if (tool.name === "read") {
    const image = tool.resultImages?.[0];
    const imageMeta = image ? [image.width && image.height ? `${image.width}×${image.height}` : "", image.mimeType ?? ""].filter(Boolean).join(" · ") : "";
    return summaryHtml([pathSummary(tool, formatReadRange(toolArgs(tool))), imageMeta]);
  }
  if (tool.name === "write") return pathSummary(tool);
  if (tool.name === "edit") {
    const operations = getEditOperations(toolArgs(tool));
    const stats = diffStats(operations);
    const editCount = operations.length ? `${operations.length} ${operations.length === 1 ? "edit" : "edits"}` : "";
    const changes = operations.length ? `+${stats.added} −${stats.deleted}` : "";
    return summaryHtml([pathSummary(tool), editCount, changes]);
  }
  return genericToolSummary(tool);
}

function toolSummaryText(tool: ToolView): string {
  return [tool.name || "tool", toolSummaryHtml(tool)].filter(Boolean).join(" · ");
}

interface ToolPresentation {
  showsDetail: boolean;
  autoOpenOnReveal: boolean;
}

function toolPresentation(tool: ToolView): ToolPresentation {
  const active = tool.status === "streaming" || tool.status === "running";
  const showsDetail = !(active && (tool.name === "read" || tool.name === "edit"));
  return { showsDetail, autoOpenOnReveal: showsDetail && tool.name === "edit" };
}

function tailFrameAttributes(ctx: AgentRenderContext, key: string): string {
  return `id="${ids.detailFrame(ctx, key)}" data-controller="agent-tail-frame" data-action="turbo:frame-load->agent-tail-frame#loaded"`;
}

function lazyTranscriptItemFrame(ctx: AgentRenderContext, key: string): string {
  return `<turbo-frame ${tailFrameAttributes(ctx, key)} data-turbo-permanent data-agent-lazy-detail-target="frame" data-src="${escapeHtml(transcriptItemPath(ctx, key))}"></turbo-frame>`;
}

export function renderToolCard(ctx: AgentRenderContext, key: string, tool: ToolView, options: { open?: boolean; live?: boolean } = {}): string {
  const liveDuration = isBashTool(tool.name) && tool.status === "running" && tool.issuedAt !== undefined && !ctx.readOnly;
  const timeout = numberArg(toolArgs(tool), "timeout") ?? 600;
  const label = {
    kind: "text" as const,
    text: toolSummaryText(tool),
    attributesHtml: liveDuration ? `data-controller="agent-elapsed" data-agent-elapsed-since-value="${tool.issuedAt}" data-agent-elapsed-prefix-value="${escapeHtml(tool.name)} · " data-agent-elapsed-suffix-value=" / ${formatDuration(timeout * 1000)}" data-agent-elapsed-format-value="duration"` : undefined,
    textAttributesHtml: liveDuration ? 'data-agent-elapsed-target="time"' : undefined,
  };
  const labelOptions = {
    leadingHtml: `<span id="${ids.itemSummaryStatus(ctx, key)}" class="agent-tool-status">${statusHtml(tool.status, ctx.readOnly)}</span>`,
    labelId: ids.itemSummaryContent(ctx, key),
    trailingHtml: tool.canAbort && !ctx.readOnly ? toolAbortHtml(ctx, key, tool) : undefined,
  };
  const active = tool.status === "streaming" || tool.status === "running";
  const content = transcriptRowContent(label, labelOptions);
  if (!toolPresentation(tool).showsDetail) {
    return `<div class="agent-tool agent-tool-summary-only ${toolClass(tool.name)} active">${contentRowHtml({ ...content, element: { tag: "div" }, primary: false })}</div>`;
  }
  const open = Boolean(options.open || active);
  const lazy = !options.live && !active && !options.open;
  return `<div class="agent-tool ${toolClass(tool.name)}${active ? " active" : ""}${tool.status === "error" ? " error" : ""}">${disclosureHtml({
    element: lazy ? { attributesHtml: 'data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load"' } : undefined,
    summary: content, open,
    bodyHtml: lazy ? lazyTranscriptItemFrame(ctx, key) : `<turbo-frame ${tailFrameAttributes(ctx, key)} class="agent-tool-detail-host">${renderToolDetail(ctx, key, tool, 100)}</turbo-frame>`,
  })}</div>`;
}

function toolAbortHtml(ctx: AgentRenderContext, key: string, tool: ToolView): string {
  const id = domId(ids.item(ctx, key), "abort");
  const noteId = `${id}_note`;
  const actions = buttonGroupHtml({
    orientation: "horizontal", semantics: "layout",
    itemsHtml: buttonHtml({
      type: "button", variant: "secondary", content: { kind: "caption", caption: "Keep running" },
      attributesHtml: 'data-action="dialog#close"',
    }) + buttonHtml({
      type: "submit", variant: "danger", content: { kind: "caption", caption: "Stop tool only" },
    }),
  });
  return buttonHtml({
    type: "button", variant: "danger",
    content: { kind: "icon-only", iconHtml: Icons.Stop, label: "Stop this tool only; the agent will continue" },
    attributesHtml: `commandfor="${escapeHtml(id)}" command="show-modal"`,
  }) + dialogHtml({
    element: { id, actions: "turbo:submit-end->dialog#submitted", attributesHtml: "data-turbo-permanent" },
    iconHtml: Icons.Stop, titleCaption: "Stop this tool?", closeLabel: "Keep running",
    bodyHtml: `<p>The agent will continue. Add a note to tell it why you stopped this tool.</p>
      <form method="post" data-controller="agent-tool-abort" data-action="keydown->agent-tool-abort#keydown" action="${escapeHtml(agentPath(ctx, `/tools/${encodeURIComponent(tool.callId)}/abort`))}">
        <label for="${escapeHtml(noteId)}">Note (optional)</label>
        <textarea class="textarea" id="${escapeHtml(noteId)}" name="note" rows="3"></textarea>
        <div class="agent-tool-abort-actions">${actions}</div>
      </form>`,
  });
}

function sourceRegionHtml(title: string, body: string, className = "agent-source-region"): string {
  return detailFullscreen(title, `<section class="${className}"><div class="agent-region-header">${escapeHtml(title)}</div>${body}</section>`);
}

interface TextWindow {
  text: string;
  hidden: number;
}

function textWindow(text: string, mode: "first" | "last", count: number): TextWindow {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.length <= count) return { text, hidden: 0 };
  return mode === "first" ? { text: lines.slice(0, count).join("\n"), hidden: lines.length - count } : { text: lines.slice(-count).join("\n"), hidden: lines.length - count };
}

function moreLink(ctx: AgentRenderContext, key: string, count: number, hidden: number, direction: "first" | "last"): string {
  if (!hidden) return "";
  const increment = Math.min(500, hidden);
  const next = count + increment;
  return `<div class="agent-more-lines"><a href="${escapeHtml(transcriptItemPath(ctx, key, `?count=${next}`))}" data-turbo-frame="${ids.detailFrame(ctx, key)}" data-action="click->agent-tail-frame#prepare" data-direction="${direction}">show ${increment} more ${increment === 1 ? "line" : "lines"}</a></div>`;
}

function tailOutput(content: string, pagination: string, direction: "first" | "last"): string {
  return `<div class="agent-tail-output" data-agent-tail-direction="${direction}">${direction === "last" ? pagination : ""}${content}${direction === "first" ? pagination : ""}</div>`;
}

interface BashViews {
  display: string;
  model: string;
  same: boolean;
  resultWindow: TextWindow;
  modelWindow: TextWindow;
}

function bashViews(tool: ToolView, count: number): BashViews {
  const details = tool.details;
  const display = details?.displayAnsi?.trimEnd() ?? "";
  const model = trimResult(tool);
  return { display, model, same: !display || display === model, resultWindow: textWindow(display || model || "(no output)", "last", count), modelWindow: textWindow(model || "(no output)", "last", count) };
}

function toolCopyButton(label: string): string {
  return copyButtonHtml({ label: `Copy ${label} to clipboard` });
}

function copyableToolBody(body: string, label: string): string {
  return `<div class="copy-region">${toolCopyButton(label)}<div class="copy-source" data-copy-source>${body}</div></div>`;
}

function comparisonHeader(title: string, primaryLabel: string, secondaryLabel = "As seen by model"): string {
  const toggle = toggleHtml({
    variant: "text-subtle",
    label: `${title} view`,
    name: "agent-region-view",
    value: "primary",
    options: [
      { label: primaryLabel, value: "primary" },
      { label: secondaryLabel, value: "model" },
    ],
  });
  return `<div class="agent-region-header agent-region-tabs"><span>${escapeHtml(title)}</span>${toggle}</div>`;
}

function renderBashResultViews(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const { display, model, same, resultWindow, modelWindow } = bashViews(tool, count);
  const result = display ? `<pre class="agent-tool-result agent-tool-region-body agent-tool-ansi">${bashOutputHtml(resultWindow.text)}</pre>` : `<pre class="agent-tool-result agent-tool-region-body">${escapeHtml(resultWindow.text)}</pre>`;
  const resultHtml = tailOutput(result, moreLink(ctx, key, count, resultWindow.hidden, "last"), "last");
  const fullResult = display ? `<pre class="agent-tool-result agent-tool-region-body agent-tool-ansi">${bashOutputHtml(display)}</pre>` : `<pre class="agent-tool-result agent-tool-region-body">${escapeHtml(model || "(no output)")}</pre>`;
  if (same) return fullscreenSourceRegion("Result", `<section class="agent-tool-region agent-bash-output"><div class="agent-region-header">Result</div>${copyableToolBody(resultHtml, "result")}</section>`, fullResult);
  const modelHtml = tailOutput(`<pre class="agent-tool-result agent-tool-region-body">${escapeHtml(modelWindow.text)}</pre>`, moreLink(ctx, key, count, modelWindow.hidden, "last"), "last");
  return `<section class="agent-tool-region agent-bash-output">${comparisonHeader("Result", "As emitted")}<div class="agent-region-pane region-primary-pane">${fullscreenSourceRegion("Result", copyableToolBody(resultHtml, "colored result"), fullResult)}</div><div class="agent-region-pane region-model-pane">${fullscreenSourceRegion("As seen by model", copyableToolBody(modelHtml, "model result"), `<pre class="agent-tool-result agent-tool-region-body">${escapeHtml(model || "(no output)")}</pre>`)}</div></section>`;
}

function renderBashCommand(command: string, streaming: boolean): string {
  const bodyClass = "agent-tool-code agent-tool-region-body";
  // Incomplete shell syntax alternates between parseable and unparseable as
  // arguments arrive. Formatting it rewrites earlier lines and toggles the
  // comparison layout, even with morph updates. Keep the source layout until
  // the command is complete, including its embedded code regions.
  if (streaming) {
    return sourceRegionHtml("Command", copyableToolBody(highlightedBashCommandHtml(command, bodyClass), "command"), "agent-tool-region agent-bash-command");
  }
  const formatted = formatBashCommandForDisplay(command);
  const embedded = embeddedBashCommand(command, formatted, bodyClass);
  const commandBody = embedded?.html ?? highlightedBashCommandHtml(formatted, bodyClass);
  if (formatted === command && !embedded?.differs) return sourceRegionHtml("Command", copyableToolBody(commandBody, "command"), "agent-tool-region agent-bash-command");

  const modelBody = `<pre class="${bodyClass}"><code>${escapeHtml(command)}</code></pre>`;
  return `<section class="agent-tool-region agent-bash-command">${comparisonHeader("Command", "Readable", "Original")}<div class="agent-region-pane region-primary-pane">${fullscreenSourceRegion("Command", copyableToolBody(commandBody, "readable command"), commandBody)}</div><div class="agent-region-pane region-model-pane">${fullscreenSourceRegion("Original", copyableToolBody(modelBody, "original command"), modelBody)}</div></section>`;
}

function renderBashDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const command = stringArg(toolArgs(tool), "command") ?? "";
  const commandHtml = renderBashCommand(command, tool.status === "streaming");
  if (tool.status === "streaming") return `<div class="agent-tool-detail">${commandHtml}</div>`;
  if (tool.status === "running") {
    // The viewer owns its generated DOM and the awaiting-output visibility state.
    const terminal = tool.tmuxSession ? `<section id="${domId(ids.item(ctx, key), "terminal", ctx.workspaceId, tool.tmuxSession)}" data-turbo-permanent class="agent-tool-region agent-bash-output agent-terminal-awaiting-output"><div class="agent-region-header">Live terminal</div><div class="agent-terminal-viewport"><div class="agent-tool-term observable-terminal-host" data-controller="agent-term" data-agent-term-workspace-id-value="${escapeHtml(ctx.workspaceId)}" data-agent-term-session-value="${escapeHtml(tool.tmuxSession)}"></div></div></section>` : "";
    return `<div class="agent-tool-detail agent-bash-detail">${commandHtml}${terminal}</div>`;
  }
  return `<div class="agent-tool-detail agent-bash-detail">${commandHtml}${renderBashResultViews(ctx, key, tool, count)}</div>`;
}

function fullscreenSourceRegion(title: string, inlineHtml: string, fullHtml: string): string {
  return `<div class="agent-detail-fullscreen"${fullscreenAttributes(title)}>${inlineHtml}<template data-agents-in-the-cloud-fullscreen-target="content">${fullHtml}</template></div>`;
}

function renderReadDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const images = toolResultImagesHtml(ctx, tool);
  const result = trimResult(tool);
  if (images) {
    const text = result ? copyableToolBody(`<pre class="agent-tool-note agent-tool-region-body">${escapeHtml(result)}</pre>`, "read result") : "";
    const region = `<section class="agent-tool-region agent-read-result">${images}${text}</section>`;
    return `<div class="agent-tool-detail">${detailFullscreen("Read", region)}</div>`;
  }
  const window = textWindow(result, "first", count);
  const path = stringArg(toolArgs(tool), "path", "file_path");
  const bodyClass = "agent-tool-code agent-tool-region-body";
  const full = codeBlockHtml(result, path, bodyClass);
  const preview = window.text === result ? full : codeBlockHtml(window.text, path, bodyClass);
  const shown = tailOutput(preview, moreLink(ctx, key, count, window.hidden, "first"), "first");
  return `<div class="agent-tool-detail">${fullscreenSourceRegion("Read", `<section class="agent-tool-region agent-read-result">${copyableToolBody(shown, "read result")}</section>`, full)}</div>`;
}

function renderWriteDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const args = toolArgs(tool);
  const content = stringArg(args, "content") ?? "";
  const path = stringArg(args, "path", "file_path");
  const shown = tool.status === "streaming" || tool.status === "running" ? { text: content, hidden: 0 } : textWindow(content, "first", count);
  const bodyClass = "agent-tool-code agent-tool-region-body";
  const full = codeBlockHtml(content, path, bodyClass);
  const highlighted = shown.text === content ? full : codeBlockHtml(shown.text, path, bodyClass);
  const preview = tailOutput(highlighted, moreLink(ctx, key, count, shown.hidden, "first"), "first");
  const error = tool.status === "error" && tool.resultText ? `<pre class="agent-tool-error-output">${escapeHtml(trimResult(tool))}</pre>` : "";
  return `<div class="agent-tool-detail">${fullscreenSourceRegion("Write", `<section class="agent-tool-region agent-write-result">${copyableToolBody(preview, "written content")}</section>`, full)}${error}</div>`;
}

function editDiffs(tool: ToolView, contextual: boolean): FileDiffMetadata[] {
  const patch = tool.details?.patch;
  if (patch) return processPatch(patch).files;
  const path = stringArg(toolArgs(tool), "path", "file_path") ?? "edited-file.txt";
  return getEditOperations(toolArgs(tool)).map((operation) => parseDiffFromFile(
    { name: path, contents: operation.oldText },
    { name: path, contents: operation.newText },
    { context: contextual ? 3 : 1_000_000 },
  ));
}

function editDiffHtml(tool: ToolView, contextual: boolean): string {
  const diffs = editDiffs(tool, contextual);
  if (!diffs.length) return "";
  const model = JSON.stringify(diffs).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
  return `<div class="agents-in-the-cloud-pierre-host agent-edit-pierre" data-controller="agent-edit-diff">${diffs.map(() => "<diffs-container></diffs-container>").join("")}<script type="application/json" data-agent-edit-diff-target="model">${model}</script></div>`;
}

function renderEditDetail(tool: ToolView): string {
  const preview = editDiffHtml(tool, true) || genericParamsHtml(tool);
  const full = editDiffHtml(tool, false) || genericParamsHtml(tool);
  const edits = fullscreenSourceRegion("Edit", `<section class="agent-tool-region agent-edit-result">${copyableToolBody(`<div class="agent-edit-details agent-tool-region-body">${preview}</div>`, "edit")}</section>`, `<div class="agent-edit-details agent-tool-region-body">${full}</div>`);
  const error = tool.status === "error" && tool.resultText ? `<pre class="agent-tool-error-output">${escapeHtml(trimResult(tool))}</pre>` : "";
  return `<div class="agent-tool-detail">${edits}${error}</div>`;
}

function renderGenericDetail(ctx: AgentRenderContext, tool: ToolView): string {
  const html = `${genericParamsHtml(tool)}${genericResultHtml(ctx, tool)}`;
  return `<div class="agent-tool-detail">${detailFullscreen(tool.name, html)}</div>`;
}

export function renderToolDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const custom = agentToolPresentations?.get(tool.name)?.detail(ctx, tool);
  if (custom !== undefined) return custom;
  if (isBashTool(tool.name)) return renderBashDetail(ctx, key, tool, count);
  if (tool.name === "read") return renderReadDetail(ctx, key, tool, count);
  if (tool.name === "write") return renderWriteDetail(ctx, key, tool, count);
  if (tool.name === "edit") return renderEditDetail(tool);
  return renderGenericDetail(ctx, tool);
}

function toolClass(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return `tool-${slug}`;
}

function toolArgs(tool: ToolView): JsonObject | undefined {
  return isJsonObject(tool.args) ? tool.args : undefined;
}

function toolArgument<Schema extends TSchema>(args: JsonObject | undefined, schema: Schema, ...keys: ToolArgumentKey[]): Static<Schema> | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (Value.Check(schema, value)) return value;
  }
  return undefined;
}

function stringArg(args: JsonObject | undefined, ...keys: ToolArgumentKey[]): string | undefined {
  return toolArgument(args, toolStringArgumentSchema, ...keys);
}

function numberArg(args: JsonObject | undefined, key: ToolArgumentKey): number | undefined {
  return toolArgument(args, toolNumberArgumentSchema, key);
}

function formatReadRange(args: JsonObject | undefined): string {
  const offset = numberArg(args, "offset");
  const limit = numberArg(args, "limit");
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  return `:${start}${end !== undefined ? `-${end}` : ""}`;
}

function pathSummary(tool: ToolView, range = ""): string {
  const args = toolArgs(tool);
  const path = stringArg(args, "path", "file_path");
  return path ? `${path}${range}` : "";
}

function truncateOneLine(text: string, limit: number): string {
  const oneLine = text.replaceAll("\n", " ");
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

function trimResult(tool: ToolView): string {
  return (tool.resultText ?? "").trimEnd();
}

function resultPreHtml(text: string, className = "agent-tool-result"): string {
  return text ? `<pre class="${className}">${escapeHtml(text)}</pre>` : "";
}

function toolResultImagesHtml(ctx: AgentRenderContext, tool: ToolView): string {
  const images = tool.resultImages ?? [];
  if (images.length === 0) return "";
  const baseTitle = pathSummary(tool) || "image";
  return `<div class="agent-tool-images">${images.map((image, index) => {
    const title = images.length === 1 ? baseTitle : `${baseTitle} ${index + 1}`;
    return `<img class="agent-media-img agent-tool-image"${fullscreenAttributes(title, "media")} src="${escapeHtml(sessionImageUrl(ctx, image))}" alt="${escapeHtml(title)}" loading="lazy">`;
  }).join("")}</div>`;
}

// Keep completed Bash output aligned with the same theme palette as its live terminal.
const ansi16 = [
  "var(--panel)", "var(--danger)", "var(--success)", "var(--warning)", "var(--accent)", "var(--decorative)", "var(--accent)", "var(--text-bright)",
  "var(--line-strong)", "var(--danger)", "var(--success)", "var(--warning)", "var(--accent)", "var(--decorative)", "var(--accent)", "var(--text-bright)",
];

function ansi256(index: number): string | undefined {
  if (index >= 0 && index < 16) return ansi16[index];
  if (index >= 16 && index <= 231) {
    const n = index - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const level = (v: number) => v === 0 ? 0 : 55 + v * 40;
    return `rgb(${level(r)},${level(g)},${level(b)})`;
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  return undefined;
}

interface AnsiStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fg?: string;
  bg?: string;
}

function styleAttr(style: AnsiStyle): string {
  const rules: string[] = [];
  if (style.bold) rules.push("font-weight:700");
  if (style.italic) rules.push("font-style:italic");
  if (style.underline) rules.push("text-decoration:underline");
  if (style.fg) rules.push(`color:${style.fg}`);
  if (style.bg) rules.push(`background-color:${style.bg}`);
  return rules.length ? ` style="${escapeHtml(rules.join(";"))}"` : "";
}

function ansiToHtml(text: string): string {
  let html = "";
  let style: AnsiStyle = {};
  let open = false;
  const close = () => {
    if (open) html += "</span>";
    open = false;
  };
  const openSpan = () => {
    const attr = styleAttr(style);
    if (attr) {
      html += `<span${attr}>`;
      open = true;
    }
  };
  const setStyle = (next: typeof style) => {
    close();
    style = next;
    openSpan();
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === "\x1b" && text[i + 1] === "]") {
      const rest = text.slice(i + 2);
      const bel = rest.indexOf("\x07");
      const st = rest.indexOf("\x1b\\");
      const end = bel >= 0 && (st < 0 || bel < st) ? bel + 3 : st >= 0 ? st + 4 : -1;
      if (end >= 0) {
        i += end;
        continue;
      }
    }
    if (text[i] === "\x1b" && /[=>78]/.test(text[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.slice(i + 2).search(/[A-Za-z]/);
      if (end >= 0) {
        const final = text[i + 2 + end];
        const raw = text.slice(i + 2, i + 2 + end);
        i += end + 3;
        if (final !== "m") continue;
        const codes = raw === "" ? [0] : raw.split(";").map((part) => part === "" ? 0 : Number(part));
        let next = { ...style };
        for (let c = 0; c < codes.length; c++) {
          const code = Number.isFinite(codes[c]) ? codes[c] : 0;
          if (code === 0) next = {};
          else if (code === 1) next.bold = true;
          else if (code === 3) next.italic = true;
          else if (code === 4) next.underline = true;
          else if (code === 22) next.bold = false;
          else if (code === 23) next.italic = false;
          else if (code === 24) next.underline = false;
          else if (code === 39) next.fg = undefined;
          else if (code === 49) next.bg = undefined;
          else if (code >= 30 && code <= 37) next.fg = ansi16[code - 30];
          else if (code >= 90 && code <= 97) next.fg = ansi16[8 + code - 90];
          else if (code >= 40 && code <= 47) next.bg = ansi16[code - 40];
          else if (code >= 100 && code <= 107) next.bg = ansi16[8 + code - 100];
          else if ((code === 38 || code === 48) && codes[c + 1] === 5) {
            const color = ansi256(codes[c + 2]);
            if (color && code === 38) next.fg = color;
            if (color && code === 48) next.bg = color;
            c += 2;
          } else if ((code === 38 || code === 48) && codes[c + 1] === 2) {
            const r = codes[c + 2], g = codes[c + 3], b = codes[c + 4];
            if ([r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
              const color = `rgb(${r},${g},${b})`;
              if (code === 38) next.fg = color;
              else next.bg = color;
            }
            c += 4;
          }
        }
        setStyle(next);
        continue;
      }
    }
    // Drop non-SGR terminal controls but keep newlines/tabs printable.
    if (text.charCodeAt(i) < 32 && text[i] !== "\n" && text[i] !== "\t") {
      i++;
      continue;
    }
    html += escapeHtml(text[i]);
    i++;
  }
  close();
  return html;
}

function hasAnsiSgr(text: string): boolean {
  return /\x1b\[[0-9;?]*m/.test(text);
}

function colorizePlainBuildOutput(text: string): string {
  const lines = text.split("\n");
  return lines.map((line) => {
    const cmake = line.match(/^(\[\s*\d+%\])(\s*)((?:Built|Building|Linking|Generating|Scanning|Consolidate)\b[^:]*)(.*)$/);
    if (cmake) {
      return `<span style="color:var(--accent)">${escapeHtml(cmake[1])}</span>${escapeHtml(cmake[2])}<span style="color:var(--success)">${escapeHtml(cmake[3])}</span>${escapeHtml(cmake[4])}`;
    }
    const diagnostic = line.match(/^(.*?)(warning|error|fatal error|failed|FAILED)(:?.*)$/i);
    if (diagnostic) {
      const color = /warn/i.test(diagnostic[2]) ? "var(--warning)" : "var(--danger)";
      return `${escapeHtml(diagnostic[1])}<span style="color:${color};font-weight:700">${escapeHtml(diagnostic[2])}</span>${escapeHtml(diagnostic[3])}`;
    }
    return escapeHtml(line);
  }).join("\n");
}

function bashOutputHtml(text: string): string {
  if (hasAnsiSgr(text)) return ansiToHtml(text);
  return colorizePlainBuildOutput(text);
}

function getEditOperations(args: JsonObject | undefined): DiffOperation[] {
  if (Array.isArray(args?.edits)) {
    return args.edits.flatMap((edit) => Value.Check(diffOperationSchema, edit) ? [edit] : []);
  }
  const oldText = stringArg(args, "oldText");
  const newText = stringArg(args, "newText");
  return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
}

function genericToolSummary(tool: ToolView): string {
  const args = toolArgs(tool);
  if (!args) return "";
  const custom = agentToolPresentations?.get(tool.name)?.summary(tool);
  if (custom !== undefined) return custom;
  const direct = stringArg(args, "command", "path", "file_path");
  if (direct) return truncateOneLine(direct, 120);
  const json = JSON.stringify(args);
  return json && json !== "{}" ? truncateOneLine(json, 120) : "";
}

function genericParamsHtml(tool: ToolView): string {
  const args = toolArgs(tool);
  if (!args) return "";
  const values = Object.values(args);
  if (values.length === 0) return "";
  if (values.length === 1 && genericToolSummary(tool) === values[0]) return "";
  return codeBlockHtml(JSON.stringify(args, null, 2), "arguments.json", "agent-tool-code");
}

function genericResultHtml(ctx: AgentRenderContext, tool: ToolView): string {
  const result = trimResult(tool);
  const images = toolResultImagesHtml(ctx, tool);
  return `${resultPreHtml(result)}${images}`;
}
