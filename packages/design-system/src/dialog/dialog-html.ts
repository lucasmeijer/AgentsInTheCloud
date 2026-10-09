import { escapeHtml } from "@agents-in-the-cloud/shared";
import { buttonHtml } from "../button/button-html.ts";
import { Icons } from "../icons/icons-html.ts";
import { attributesHtml, stimulusAttributes, stimulusHtml } from "../html.ts";
import { panelHtml } from "../panel/panel-html.ts";

export interface DialogOptions {
  element: {
    id?: string;
    /** Extra Stimulus controllers and actions, rendered alongside the dialog controller. */
    controllers?: string;
    actions?: string;
    /** Caller-owned attributes; aria-label is owned by titleCaption, and data-controller and data-action by controllers and actions. Attribute values containing external input must be escaped. */
    attributesHtml?: string;
  };
  /** Trusted, already-escaped decorative icon. */
  iconHtml: string;
  /** Plain-text title caption. Dialog owns its body-text typography; callers supply no heading styling. */
  titleCaption: string;
  /** Optional sentence with an inline control. Text is escaped; controlHtml is trusted. titleCaption remains the accessible dialog name. */
  titleParts?: { before: string; controlHtml: string; after: string };
  /** Trusted, already-escaped body contents. */
  bodyHtml: string;
  /** Padded by default. Use full-bleed when child regions own spacing or separators must reach both edges. */
  bodyLayout?: "padded" | "full-bleed";
  /** Trusted, already-escaped footer contents. Omit when the dialog has no footer actions. */
  footerHtml?: string;
  /** Accessible close-button label. */
  closeLabel?: string;
  /** Omits the header's cancel control when the flow must provide its own completion action. */
  omitCancelButton?: boolean;
}

/** Renders a native modal host around the design-system panel surface. */
export function dialogHtml(options: DialogOptions): string {
  const { element } = options;
  const id = element.id === undefined ? "" : ` id="${escapeHtml(element.id)}"`;
  const closeLabel = options.closeLabel ?? "Close dialog";
  const cancelButton = options.omitCancelButton ? "" : `<form class="dialog__close-form" method="dialog">${buttonHtml({
    type: "submit",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Close, label: closeLabel },
  })}</form>`;
  const title = options.titleParts
    ? `<div class="panel__title dialog__title" role="heading" aria-level="2">${options.iconHtml}<span>${escapeHtml(options.titleParts.before)} ${options.titleParts.controlHtml}${escapeHtml(options.titleParts.after)}</span></div>`
    : `<h2 class="panel__title dialog__title">${options.iconHtml}<span>${escapeHtml(options.titleCaption)}</span></h2>`;
  const panel = panelHtml({
    element: { tag: "div" },
    headerHtml: `${title}${cancelButton}`,
    bodyHtml: options.bodyHtml,
    bodyLayout: options.bodyLayout ?? "padded",
    bodyOverflow: "scroll",
    footerHtml: options.footerHtml,
  });
  return `<dialog${id} class="${escapeHtml("dialog")}" aria-label="${escapeHtml(options.titleCaption)}"${stimulusHtml(["dialog", element.controllers], [element.actions])}${attributesHtml(element.attributesHtml, stimulusAttributes)}>${panel}</dialog>`;
}
