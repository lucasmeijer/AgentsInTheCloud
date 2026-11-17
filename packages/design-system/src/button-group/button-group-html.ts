import { escapeHtml } from "@agents-in-the-cloud/shared";
import { attributesHtml } from "../html.ts";

interface ButtonGroupBase {
  orientation: "horizontal" | "vertical";
  itemsHtml: string;
  /**
   * Caller-owned integration attributes. Do not supply class, role, or
   * aria-label here. Attribute values containing external input must be escaped.
   */
  attributesHtml?: string;
}

export type ButtonGroupOptions = ButtonGroupBase & (
  | { semantics: "layout" }
  | { semantics: "group"; label: string }
);

export function buttonGroupHtml(options: ButtonGroupOptions): string {
  const semantics = options.semantics === "group" ? ` role="group" aria-label="${escapeHtml(options.label)}"` : "";
  return `<div class="button-group button-group--${options.orientation}"${semantics}${attributesHtml(options.attributesHtml)}>${options.itemsHtml}</div>`;
}
