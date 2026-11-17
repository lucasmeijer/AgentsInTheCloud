import { attributesHtml } from "../html.ts";
import { contentRowClasses, contentRowContentHtml } from "./content-row-markup.ts";

export interface ContentRowElement {
  tag: "a" | "button" | "div" | "span";
  attributesHtml?: string;
}

export interface ContentRowLabel {
  kind: "text";
  text: string;
  attributesHtml?: string;
  textAttributesHtml?: string;
}

interface ContentRowSlots {
  label: ContentRowLabel;
  leadingHtml?: string;
  trailingHtml?: string;
  tone?: "default" | "muted" | "danger";
  width?: "fit" | "fill";
}

export type ContentRowContent = ContentRowSlots & (
  | { kind: "compact"; description?: never }
  | { kind: "multiline"; description?: string }
);

type ContentRowInteraction =
  | { element: ContentRowElement; primary?: boolean }
  | {
      element?: never;
      container?: { attributesHtml?: string };
      primary: ContentRowElement;
      leadingActionsHtml?: string;
      engagedActionsHtml?: string;
    };

export type ContentRowOptions = ContentRowContent & ContentRowInteraction;

function elementHtml(element: ContentRowElement, className: string, content: string): string {
  return `<${element.tag} class="${className}"${attributesHtml(element.attributesHtml)}>${content}</${element.tag}>`;
}

export function contentRowHtml(options: ContentRowOptions): string {
  const content = contentRowContentHtml(options);
  if (options.element) {
    return elementHtml(options.element, contentRowClasses(options, true, options.primary !== false), content);
  }
  const primary = elementHtml(options.primary, "content-row__primary", content);
  const actions = options.engagedActionsHtml ? `<div class="content-row__actions content-row__actions--engaged" data-controller="content-row-actions">${options.engagedActionsHtml}</div>` : "";
  const leading = options.leadingActionsHtml ? `<div class="content-row__actions content-row__actions--leading">${options.leadingActionsHtml}</div>` : "";
  return `<div class="${contentRowClasses(options, false, false)}"${attributesHtml(options.container?.attributesHtml)}>${leading}${primary}${actions}</div>`;
}

export function contentRowElement<T extends HTMLElement = HTMLElement>(options: ContentRowOptions): T {
  const template = document.createElement("template");
  template.innerHTML = contentRowHtml(options);
  const element = template.content.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error("Content row renderer did not produce an HTML element");
  // SAFETY: The caller chooses T to match the element tag supplied in the same options object.
  return element as T;
}
