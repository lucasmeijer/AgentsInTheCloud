import { attributesHtml } from "../html.ts";
import { buttonPresentation, type ButtonContent, type ButtonVariant } from "./button-content.ts";

export type { ButtonContent, ButtonVariant } from "./button-content.ts";

export interface ButtonOptions {
  type: "button" | "submit" | "reset";
  variant: ButtonVariant;
  content: ButtonContent;
  disabled?: boolean;
  /**
   * Caller-owned integration attributes. Do not supply class, type, disabled,
   * title, or aria-label here. Attribute values containing external input must
   * be escaped.
   */
  attributesHtml?: string;
}

export function buttonHtml(options: ButtonOptions): string {
  const presentation = buttonPresentation(options.variant, options.content);
  const disabled = options.disabled ? " disabled" : "";
  return `<button class="${presentation.className}" type="${options.type}"${presentation.accessibilityHtml}${disabled}${attributesHtml(options.attributesHtml)}>${presentation.contentHtml}</button>`;
}

export function buttonElement(options: ButtonOptions): HTMLButtonElement {
  const template = document.createElement("template");
  template.innerHTML = buttonHtml(options);
  const button = template.content.firstElementChild;
  if (!(button instanceof HTMLButtonElement)) throw new Error("Button renderer did not produce a button element");
  return button;
}
