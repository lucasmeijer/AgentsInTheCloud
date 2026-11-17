import { escapeHtml } from "@agents-in-the-cloud/shared";
import type { ContentRowContent } from "../content-row/content-row-html.ts";
import { contentRowClasses, contentRowContentHtml } from "../content-row/content-row-markup.ts";
import { attributesHtml } from "../html.ts";
import { Icons } from "../icons/icons-html.ts";

export type DisclosureSummary = ContentRowContent & {
  attributesHtml?: string;
};

export interface DisclosureOptions {
  element?: { id?: string; attributesHtml?: string };
  summary: DisclosureSummary;
  bodyHtml: string;
  bodyAttributesHtml?: string;
  open?: boolean;
}

export function disclosureHtml(options: DisclosureOptions): string {
  return `${disclosureOpeningHtml(options)}${options.bodyHtml}${disclosureClosingHtml}`;
}

export function disclosureOpeningHtml(options: Omit<DisclosureOptions, "bodyHtml">): string {
  const id = options.element?.id === undefined ? "" : ` id="${escapeHtml(options.element.id)}"`;
  const content: ContentRowContent = { ...options.summary, leadingHtml: `${Icons.Disclosure}${options.summary.leadingHtml ?? ""}` };
  const summary = `<summary class="${contentRowClasses(content, true, true)}"${attributesHtml(options.summary.attributesHtml)}>${contentRowContentHtml(content)}</summary>`;
  return `<details${id} class="disclosure"${options.open ? " open" : ""}${attributesHtml(options.element?.attributesHtml)}>${summary}<div class="disclosure-content"${attributesHtml(options.bodyAttributesHtml)}>`;
}

export const disclosureClosingHtml = "</div></details>";

export interface AuthoredDisclosureParts {
  detailsClass: string;
  summaryClass: string;
  labelOpeningHtml: string;
  labelClosingHtml: string;
  contentOpeningHtml: string;
  contentClosingHtml: string;
}

const labelSlot = "\uE000";

export function authoredDisclosureParts(): AuthoredDisclosureParts {
  const content: ContentRowContent = { kind: "compact", tone: "muted", label: { kind: "text", text: labelSlot }, leadingHtml: Icons.Disclosure };
  const summaryHtml = contentRowContentHtml(content);
  const label = summaryHtml.indexOf(labelSlot);
  return {
    detailsClass: "disclosure",
    summaryClass: contentRowClasses(content, true, true),
    labelOpeningHtml: summaryHtml.slice(0, label),
    labelClosingHtml: summaryHtml.slice(label + labelSlot.length),
    contentOpeningHtml: '<div class="disclosure-content">',
    contentClosingHtml: "</div>",
  };
}
