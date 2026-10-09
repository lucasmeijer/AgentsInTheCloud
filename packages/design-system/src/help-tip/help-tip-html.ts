import { escapeHtml } from "@agents-in-the-cloud/shared";

interface HelpTipOptions {
  /** Accessible name for the "?" button, phrased as the question it answers. */
  label: string;
  /** Plain-text explanation. */
  text: string;
}

/** A small "?" that explains the adjacent text on click or tap, including touch screens. */
export function helpTipHtml(options: HelpTipOptions): string {
  return `<span class="help-tip" data-controller="help-tip"><button type="button" class="help-tip__trigger" data-help-tip-target="trigger" aria-label="${escapeHtml(options.label)}">?</button><span class="floating-surface help-tip__text" role="tooltip" popover="auto" data-help-tip-target="text">${escapeHtml(options.text)}</span></span>`;
}
