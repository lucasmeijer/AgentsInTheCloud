import { Icons } from "../icons/icons-html.ts";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { buttonConfirmationMarkup } from "../button-confirmation/button-confirmation-markup.ts";

interface CopyButtonOptions {
  label: string;
  caption?: string;
  copyText?: string;
  disabled?: boolean;
  action?: string;
  attributesHtml?: string;
}

export function copyButtonHtml(options: CopyButtonOptions): string {
  return buttonConfirmationMarkup({
    type: "button", variant: "secondary", label: options.label,
    content: options.caption === undefined
      ? { kind: "icon-only", iconHtml: Icons.Copy, label: options.label }
      : { kind: "caption", caption: options.caption, iconHtml: Icons.Copy },
    confirmationLabel: "Copied to clipboard", disabled: options.disabled,
    attributesHtml: [
      options.copyText === undefined ? undefined : `data-copy-text="${escapeHtml(options.copyText)}"`,
      options.attributesHtml,
    ].filter(Boolean).join(" "),
  }, { action: options.action });
}
