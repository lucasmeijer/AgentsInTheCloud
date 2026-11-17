import { escapeHtml } from "@agents-in-the-cloud/shared";
import { buttonHtml } from "../button/button-html.ts";
import { Icons } from "../icons/icons-html.ts";
import { attributesHtml, stimulusAttributes, stimulusHtml } from "../html.ts";
import { panelHtml } from "../panel/panel-html.ts";

export interface DialogOptions {
  element: {
    id?: string;
    controllers?: string;
    actions?: string;
    attributesHtml?: string;
  };
  iconHtml: string;
  titleCaption: string;
  titleParts?: { before: string; controlHtml: string; after: string };
  bodyHtml: string;
  bodyLayout?: "padded" | "full-bleed";
  footerHtml?: string;
  closeLabel?: string;
  omitCancelButton?: boolean;
}

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
