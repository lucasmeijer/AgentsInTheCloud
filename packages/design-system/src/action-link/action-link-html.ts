import { escapeHtml } from "@agents-in-the-cloud/shared";
import { attributesHtml } from "../html.ts";
import { buttonPresentation, type ButtonContent, type ButtonVariant } from "../button/button-content.ts";
import { comparisonRingSvgHtml, type Comparison } from "../comparison-ring/comparison-ring-html.ts";

export interface ActionLinkOptions {
  href: string;
  variant: ButtonVariant;
  content: ButtonContent;
  /** Icon-only: two 0–100 values on one clockwise ring. Shared arc is neutral;
   * reference beyond value is green; value beyond reference is red. A dim full-circle
   * track preserves the button outline, including at zero. Does not imply busy. */
  perimeterComparison?: Comparison;
  /**
   * Caller-owned integration attributes. Do not supply class, href, title, or
   * aria-label here. Attribute values containing external input must be escaped.
   */
  attributesHtml?: string;
}

export function actionLinkHtml(options: ActionLinkOptions): string {
  const presentation = buttonPresentation(options.variant, options.content);
  const comparison = options.perimeterComparison;
  if (comparison && options.content.kind !== "icon-only") throw new Error("A comparison ring requires an icon-only link");
  const perimeter = comparison ? comparisonRingSvgHtml(comparison, "action-link__perimeter") : "";
  return `<a class="${presentation.className}${comparison ? " action-link--comparison" : ""}" href="${escapeHtml(options.href)}"${presentation.accessibilityHtml}${attributesHtml(options.attributesHtml)}>${perimeter}${presentation.contentHtml}</a>`;
}
