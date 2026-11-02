import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml } from "@agents-in-the-cloud/shared";

export function renderNotice(level: "info" | "error", message: string): string {
  return `<div class="agent-noticeline ${escapeHtml(level)}" data-controller="agent-notice" data-agent-notice-auto-dismiss-value="${level !== "error"}"><span role="${level === "error" ? "alert" : "status"}">${escapeHtml(message)}</span>${level === "error" ? buttonHtml({
    type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss notice" },
    attributesHtml: 'data-action="click->agent-notice#dismiss"',
  }) : ""}</div>`;
}
