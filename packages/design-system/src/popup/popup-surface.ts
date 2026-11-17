import { escapeHtml } from "@agents-in-the-cloud/shared";
import { attributesHtml, classNames } from "../html.ts";

export interface PopupMenuOptions {
  id: string;
  label: string;
  contentHtml: string;
  placement?: "below" | "above";
  attributesHtml?: string;
}

export function popupMenuHtml(options: PopupMenuOptions): string {
  const className = classNames("floating-surface", "popup-menu", "action-list", options.placement && "popup-menu-anchored", options.placement === "above" && "opens-above");
  return `<div class="${escapeHtml(className)}" id="${escapeHtml(options.id)}" role="menu" aria-label="${escapeHtml(options.label)}" popover="auto"${attributesHtml(options.attributesHtml)}>${options.contentHtml}</div>`;
}

