import { escapeHtml } from "@agents-in-the-cloud/shared";
import { buttonHtml } from "../button/button-html.ts";
import { Icons } from "../icons/icons-html.ts";

export interface WarningBannerOptions {
  /** Without a title, the message shares the dismiss row to save space. */
  title?: string;
  message?: string;
  actionsHtml?: string;
  role?: "status" | "alert";
  /** Persisted dismissal posts a state token; local dismissal binds a browser action. */
  dismiss?: { action: string; state: string } | { buttonAttributesHtml: string; label?: string };
}

/** A persistent warning with optional actions and a single-click dismissal. */
export function warningBannerHtml(options: WarningBannerOptions): string {
  let dismiss = "";
  if (options.dismiss) {
    const local = "buttonAttributesHtml" in options.dismiss ? options.dismiss : undefined;
    const button = buttonHtml({
      type: local ? "button" : "submit", variant: "secondary",
      content: { kind: "icon-only", iconHtml: Icons.Close, label: local?.label ?? "Dismiss warning" },
      attributesHtml: local?.buttonAttributesHtml,
    });
    dismiss = "action" in options.dismiss
      ? `<form method="post" action="${escapeHtml(options.dismiss.action)}" data-turbo="true"><input type="hidden" name="state" value="${escapeHtml(options.dismiss.state)}">${button}</form>`
      : button;
  }
  const message = options.message ? `<p>${escapeHtml(options.message)}</p>` : "";
  const header = options.title === undefined ? message : `<strong>${escapeHtml(options.title)}</strong>`;
  const bodyMessage = options.title === undefined ? "" : message;
  return `<aside class="warning-banner" role="${options.role ?? "status"}"><div class="warning-banner__header">${header}${dismiss}</div>${bodyMessage || options.actionsHtml ? `<div class="warning-banner__body">${bodyMessage}${options.actionsHtml ? `<div class="warning-banner__actions">${options.actionsHtml}</div>` : ""}</div>` : ""}</aside>`;
}
