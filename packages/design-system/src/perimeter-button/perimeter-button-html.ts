import { escapeHtml } from "@agents-in-the-cloud/shared";
import type { ButtonVariant } from "../button/button-content.ts";
import { attributesHtml, classNames, htmlContent, stimulusAttributes, stimulusHtml, type HtmlContent } from "../html.ts";

interface PerimeterButtonState<State extends string> {
  name: State;
  content: HtmlContent;
  /** Accessible name while in this state; required for icon-only buttons. */
  label?: string;
}

interface PerimeterButtonOptions<State extends string> {
  /** Names the `<kind>-button` class and its `data-<kind>-*` attributes. */
  kind: "activity" | "progress";
  state: State;
  /** The first state is at rest; any other state marks the button busy. */
  states: readonly [PerimeterButtonState<State>, PerimeterButtonState<State>];
  variant: ButtonVariant;
  iconOnly?: boolean;
  /** Extra Stimulus controllers and actions, rendered alongside the perimeter-button controller. */
  controllers?: string;
  actions?: string;
  attributesHtml?: string;
  ownedAttributesHtml?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  id?: string;
}

/** Internal renderer for buttons whose alternate states share a stable perimeter and width. */
export function perimeterButtonHtml<State extends string>(options: PerimeterButtonOptions<State>): string {
  const component = `${options.kind}-button`;
  const current = options.states.find(({ name }) => name === options.state)!;
  const label = options.iconOnly ? ` title="${escapeHtml(current.label!)}" aria-label="${escapeHtml(current.label!)}"` : "";
  const busy = options.state !== options.states[0].name ? ' aria-busy="true"' : "";
  const id = options.id ? ` id="${escapeHtml(options.id)}"` : "";
  const className = escapeHtml(classNames("button", options.variant, options.iconOnly && "icon-only", component));
  const disabled = options.disabled ? " disabled" : "";
  const perimeter = `<svg class="${component}__perimeter" aria-hidden="true"><rect pathLength="100"/></svg>`;
  const contents = options.states.map(({ name, content }) => `<span class="${component}__content" data-${options.kind}-content="${escapeHtml(name)}" aria-hidden="${name !== options.state}">${htmlContent(content)}</span>`).join("");

  return `<button${id} class="${className}" type="${options.type ?? "button"}" data-${options.kind}-state="${escapeHtml(options.state)}"${stimulusHtml(["perimeter-button", options.controllers], [options.actions])}${disabled}${busy}${label}${options.ownedAttributesHtml ? ` ${options.ownedAttributesHtml}` : ""}${attributesHtml(options.attributesHtml, stimulusAttributes)}>${perimeter}${contents}</button>`;
}
