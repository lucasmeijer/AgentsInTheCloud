import { type ContentRowContent, type ContentRowLabel } from "@agents-in-the-cloud/design-system/content-row";
import { renderMarkdown } from "@agents-in-the-cloud/markdown";
import { highlightCodeHtmlForPath } from "@agents-in-the-cloud/syntax";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import type { AgentRenderContext } from "./render-context.ts";

export function markdown(ctx: AgentRenderContext, text: string): string {
  return renderMarkdown(ctx.workspaceId, text);
}

export function transcriptRow(html: string): string {
  return `<div class="agent-row">${html}</div>`;
}

export function transcriptRowContent(label: ContentRowLabel, options: { leadingHtml?: string; trailingHtml?: string; labelId?: string } = {}): ContentRowContent {
  return {
    kind: "compact",
    leadingHtml: options.leadingHtml,
    trailingHtml: options.trailingHtml,
    label: { ...label, textAttributesHtml: [label.textAttributesHtml, options.labelId ? `id="${escapeHtml(options.labelId)}"` : ""].filter(Boolean).join(" ") },
  };
}

/**
 * A link that expands and scrolls to `target`, an item key, anchor or tool call ID, in this Agent's transcript. It
 * names the Agent: a subagent's transcript shown in its root Agent's pane reveals its own items.
 */
export function transcriptTargetLink(ctx: AgentRenderContext, target: string, label: string): string {
  const query = new URLSearchParams({ agent: ctx.agentId, agentTarget: target });
  return `<a href="/workspaces/${encodeURIComponent(ctx.workspaceId)}?${escapeHtml(query.toString())}" class="agent-trace-link" data-action="agent-pane#reveal" data-agent-pane-item-param="${escapeHtml(target)}" data-agent-pane-agent-param="${escapeHtml(ctx.agentId)}">${escapeHtml(label)}</a>`;
}

export function detailTableHtml(rows: Array<{ label: string; html: string }>): string {
  return `<div class="agent-tool-detail"><table class="agent-detail-table"><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${row.html}</td></tr>`).join("")}</tbody></table></div>`;
}

export function renderMarkdownRow(ctx: AgentRenderContext, text: string, className: string): string {
  const body = markdown(ctx, text);
  return body ? transcriptRow(`<div class="${className}">${body}</div>`) : "";
}

export function fullscreenAttributes(title: string, mode: "template" | "media" = "template"): string {
  return ` data-controller="agents-in-the-cloud-fullscreen" data-agents-in-the-cloud-fullscreen-mode-value="${mode}" data-agents-in-the-cloud-fullscreen-title-value="${escapeHtml(title)}"`;
}

export function detailFullscreen(title: string, html: string): string {
  return `<div class="agent-detail-fullscreen"${fullscreenAttributes(title)}>${html}<template data-agents-in-the-cloud-fullscreen-target="content">${html}</template></div>`;
}

export function codeBlockHtml(code: string, filePath: string | undefined, className = "agent-tool-code"): string {
  const highlighted = highlightCodeHtmlForPath(code, filePath);
  const languageClass = highlighted.language ? ` language-${escapeHtml(highlighted.language)}` : "";
  return `<pre class="${className}${languageClass}"><code>${highlighted.html}</code></pre>`;
}
