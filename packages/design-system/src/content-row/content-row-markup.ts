import { escapeHtml } from "@agents-in-the-cloud/shared";
import { attributesHtml, classNames } from "../html.ts";
import type { ContentRowContent } from "./content-row-html.ts";

export function contentRowClasses(content: ContentRowContent, single: boolean, primary: boolean): string {
  return classNames("content-row", `content-row--${content.kind}`, `content-row--${content.width ?? "fit"}`, single && "content-row--single", content.tone === "muted" && "is-muted", content.tone === "danger" && "is-danger", primary && "content-row__primary");
}

export function contentRowContentHtml(options: ContentRowContent): string {
  const label = options.label;
  const labelHtml = `<span class="content-row__label"${attributesHtml(label.attributesHtml)}><span class="content-row__label-text"${attributesHtml(label.textAttributesHtml)}>${escapeHtml(label.text)}</span></span>`;
  return `${options.leadingHtml ? `<span class="content-row__icon">${options.leadingHtml}</span>` : ""}<span class="content-row__content">${labelHtml}${options.description ? `<span class="content-row__description">${escapeHtml(options.description)}</span>` : ""}</span>${options.trailingHtml ? `<span class="content-row__metadata">${options.trailingHtml}</span>` : ""}`;
}
