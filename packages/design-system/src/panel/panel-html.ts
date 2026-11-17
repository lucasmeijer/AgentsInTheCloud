import { escapeHtml } from "@agents-in-the-cloud/shared";
import { attributesHtml, classNames } from "../html.ts";

export interface PanelOptions {
  element: {
    tag: "aside" | "div" | "section";
    attributesHtml?: string;
  };
  headerHtml: string;
  bodyHtml: string;
  bodyLayout?: "padded" | "full-bleed";
  bodyOverflow?: "scroll" | "contained";
  footerHtml?: string;
}

export function panelHtml(options: PanelOptions): string {
  const { element } = options;
  const footer = options.footerHtml === undefined ? "" : `<footer class="panel__footer">${options.footerHtml}</footer>`;
  return `<${element.tag} class="${escapeHtml("panel")}"${attributesHtml(element.attributesHtml)}><header class="panel__header">${options.headerHtml}</header><div class="${escapeHtml(classNames("panel__body", options.bodyLayout === "padded" && "panel__body--padded", options.bodyOverflow === "scroll" && "panel__body--scroll"))}">${options.bodyHtml}</div>${footer}</${element.tag}>`;
}
