import { escapeHtml } from "@agents-in-the-cloud/shared";
import type { ButtonVariant } from "../button/button-content.ts";
import { type HtmlContent } from "../html.ts";
import { perimeterButtonHtml } from "../perimeter-button/perimeter-button-html.ts";

export type ActivityButtonContent = HtmlContent;
export type ActivityButtonState = "initial" | "active";

interface ActivityButtonBase {
  initialContent: ActivityButtonContent;
  activeContent: ActivityButtonContent;
  state: ActivityButtonState;
  variant: ButtonVariant;
  /** Caller-owned attributes. Do not supply activity state, aria-busy, title, aria-label, data-controller, or data-action attributes here. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
  /** Stimulus controllers and actions; the button renders them alongside its own controller. */
  controllers?: string;
  actions?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  id?: string;
}

export type ActivityButtonOptions = ActivityButtonBase & (
  | { iconOnly: true; initialLabel: string; activeLabel: string }
  | { iconOnly?: false; initialLabel?: never; activeLabel?: never }
);

/**
 * Renders a long-running action which remains available to stop or cancel the
 * active operation. Both states participate in sizing, so captions do not shift.
 */
export function activityButtonHtml(options: ActivityButtonOptions): string {
  return perimeterButtonHtml({
    kind: "activity",
    state: options.state,
    states: [
      { name: "initial", content: options.initialContent, label: options.initialLabel },
      { name: "active", content: options.activeContent, label: options.activeLabel },
    ],
    variant: options.variant,
    iconOnly: options.iconOnly,
    controllers: options.controllers,
    actions: options.actions,
    attributesHtml: options.attributesHtml,
    ownedAttributesHtml: options.iconOnly ? `data-activity-initial-label="${escapeHtml(options.initialLabel)}" data-activity-active-label="${escapeHtml(options.activeLabel)}"` : undefined,
    type: options.type,
    disabled: options.disabled,
    id: options.id,
  });
}
