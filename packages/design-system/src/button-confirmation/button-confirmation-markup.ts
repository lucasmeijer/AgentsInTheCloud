import { escapeHtml } from "@agents-in-the-cloud/shared";
import { buttonPresentation } from "../button/button-content.ts";
import { attributesHtml, classNames, stimulusAttributes, stimulusHtml } from "../html.ts";
import { Icons } from "../icons/icons-html.ts";
import type { ButtonConfirmationOptions } from "./button-confirmation-html.ts";

/**
 * Package-private composition seam for the standalone and clipboard buttons.
 * A clipboard button carries its controller and action in the server markup, so Turbo morphs keep them.
 */
export function buttonConfirmationMarkup(options: ButtonConfirmationOptions, copyButton?: { action?: string }): string {
  const presentation = buttonPresentation(options.variant, options.content);
  const label = options.label ?? (options.content.kind === "caption" ? options.content.caption : options.content.label);
  const confirmed = options.confirmed ?? false;
  const stimulus = copyButton ? stimulusHtml(["button-confirmation", "copy-button"], [copyButton.action, "click->copy-button#copy"]) : stimulusHtml(["button-confirmation"]);
  const title = options.label !== undefined || options.content.kind === "icon-only" ? ` title="${escapeHtml(label)}"` : "";
  return `<button class="${classNames(presentation.className, "button-confirmation", copyButton && "copy-button")}" type="${options.type}"${title} aria-label="${escapeHtml(confirmed ? options.confirmationLabel : label)}"${options.disabled ? " disabled" : ""}${stimulus} data-button-confirmation-confirmed-value="${confirmed}" data-button-confirmation-label-value="${escapeHtml(label)}" data-button-confirmation-confirmed-label-value="${escapeHtml(options.confirmationLabel)}"${attributesHtml(options.attributesHtml, copyButton ? stimulusAttributes : ["data-controller"])}><span class="button-confirmation__content button-confirmation__initial" data-button-confirmation-target="initial" aria-hidden="${confirmed}">${presentation.contentHtml}</span><span class="button-confirmation__content button-confirmation__check" data-button-confirmation-target="check" role="status" aria-label="${escapeHtml(options.confirmationLabel)}" aria-hidden="${!confirmed}">${Icons.Check}</span></button>`;
}
