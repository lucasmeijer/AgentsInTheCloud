import type { ActivityButtonState } from "./activity-button-html.ts";

interface ActivityButtonElement {
  dataset: DOMStringMap;
  classList: { contains(token: string): boolean };
  title: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function setActivityButtonState(button: ActivityButtonElement, state: ActivityButtonState): void {
  button.dataset.activityState = state;
  if (state === "active") button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");

  if (button.classList.contains("icon-only")) {
    const label = state === "active" ? button.dataset.activityActiveLabel! : button.dataset.activityInitialLabel!;
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}
