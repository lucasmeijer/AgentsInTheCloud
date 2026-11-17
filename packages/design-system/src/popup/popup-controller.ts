import { Controller } from "@hotwired/stimulus";
import { PopupPosition } from "./popup-position.ts";
import { contentRowElement } from "../content-row/content-row-html.ts";
import { popupMenuHtml } from "./popup-surface.ts";
import { buttonElement } from "../button/button-html.ts";

let menuSequence = 0;
const enabledItem = "[role^='menuitem']:not(:disabled):not([aria-disabled='true']):not([hidden])";

function navigateMenu(menu: HTMLElement, event: KeyboardEvent): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(menu.querySelectorAll<HTMLElement>(enabledItem));
  if (!items.length) return;
  const current = event.target instanceof HTMLElement ? items.indexOf(event.target) : -1;
  event.preventDefault();
  const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  items[index]!.focus();
}

function focusMenu(menu: HTMLElement): void {
  (menu.querySelector<HTMLElement>(`${enabledItem}[aria-checked='true']`) ?? menu.querySelector<HTMLElement>(enabledItem))?.focus();
}


export class PopupController extends Controller<HTMLElement> {
  private trigger!: HTMLButtonElement;
  private menu!: HTMLElement;
  private position!: PopupPosition;

  connect(): void {
    this.trigger = this.element.querySelector<HTMLButtonElement>("[data-popup-menu-trigger]")!;
    this.menu = this.element.querySelector<HTMLElement>(".popup-menu[popover]")!;
    this.position = new PopupPosition(this.trigger, this.menu);
    this.menu.addEventListener("click", this.choose);
    this.menu.addEventListener("toggle", this.syncOpenState);
    this.menu.addEventListener("keydown", this.keydown);
    this.trigger.addEventListener("keydown", this.openFromKeyboard);
  }

  disconnect(): void {
    this.position.disconnect();
    this.menu.removeEventListener("click", this.choose);
    this.menu.removeEventListener("toggle", this.syncOpenState);
    this.menu.removeEventListener("keydown", this.keydown);
    this.trigger.removeEventListener("keydown", this.openFromKeyboard);
  }

  private readonly syncOpenState = (event: ToggleEvent): void => {
    this.trigger.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "open") focusMenu(this.menu);
  };

  private readonly choose = (event: MouseEvent): void => {
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>(enabledItem) : null;
    if (!item) return;
    if (item.getAttribute("role") === "menuitemradio") {
      for (const candidate of this.menu.querySelectorAll<HTMLElement>("[role='menuitemradio']")) candidate.setAttribute("aria-checked", String(candidate === item));
    }
    this.menu.hidePopover();
    this.trigger.focus();
  };

  private readonly keydown = (event: KeyboardEvent): void => navigateMenu(this.menu, event);

  private readonly openFromKeyboard = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    this.menu.showPopover();
  };

}

export class PopupSelectController extends Controller<HTMLSelectElement> {
  private button!: HTMLButtonElement;
  private menu!: HTMLDivElement;
  private position!: PopupPosition;
  private anchor!: HTMLElement;
  private observer!: MutationObserver;
  private resetTimer?: number;

  connect(): void {
    this.anchor = this.element.parentElement!;
    this.anchor.classList.add("popup-menu-anchor");
    this.element.classList.add("popup-select-native");

    this.button = buttonElement({
      type: "button",
      variant: "secondary",
      content: { kind: "caption", caption: this.element.selectedOptions[0]?.textContent?.trim() || this.element.value },
      attributesHtml: "data-popup-menu-trigger data-popup-select-trigger",
    });
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");

    const template = document.createElement("template");
    template.innerHTML = popupMenuHtml({
      id: `${this.element.id || `popup_select_${++menuSequence}`}_menu`,
      label: this.accessibleName(),
      placement: this.element.dataset.popupPlacement === "above" ? "above" : "below",
      contentHtml: "",
    });
    // SAFETY: popupMenuHtml renders a div as its root.
    this.menu = template.content.firstElementChild as HTMLDivElement;
    this.button.setAttribute("aria-controls", this.menu.id);
    this.button.setAttribute("popovertarget", this.menu.id);

    this.element.after(this.button, this.menu);
    this.position = new PopupPosition(this.button, this.menu);
    this.element.addEventListener("change", this.sync);
    this.menu.addEventListener("keydown", this.keydown);
    this.button.addEventListener("keydown", this.openFromKeyboard);
    this.element.form?.addEventListener("reset", this.reset);
    this.menu.addEventListener("toggle", this.syncOpenState);
    this.observer = new MutationObserver(this.sync);
    this.observer.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ["selected", "disabled"] });
    this.sync();
  }

  disconnect(): void {
    this.position.disconnect();
    this.element.removeEventListener("change", this.sync);
    this.menu.removeEventListener("keydown", this.keydown);
    this.button.removeEventListener("keydown", this.openFromKeyboard);
    this.element.form?.removeEventListener("reset", this.reset);
    this.menu.removeEventListener("toggle", this.syncOpenState);
    this.observer.disconnect();
    window.clearTimeout(this.resetTimer);
    this.button.remove();
    this.menu.remove();
    this.element.classList.remove("popup-select-native");
    this.anchor.classList.remove("popup-menu-anchor");
  }

  private readonly sync = (): void => {
    const selected = this.element.selectedOptions[0];
    const selectedLabel = selected?.textContent?.trim() || this.element.value;
    this.button.querySelector<HTMLElement>(".button__caption")!.textContent = selectedLabel;
    this.button.disabled = this.element.disabled;
    this.button.title = this.element.title;
    const accessibleName = this.accessibleName();
    this.button.setAttribute("aria-label", `${accessibleName}: ${selectedLabel}`);
    this.menu.setAttribute("aria-label", accessibleName);
    this.menu.replaceChildren(...Array.from(this.element.options, (option) => this.renderOption(option)));
  };

  private renderOption(option: HTMLOptionElement): HTMLButtonElement {
    const item = contentRowElement<HTMLButtonElement>({
      width: "fill",
      kind: "compact",
      label: { kind: "text", text: option.textContent ?? option.value },
      element: { tag: "button", attributesHtml: `type="button" role="menuitemradio" aria-checked="${option.selected}"${option.disabled ? " disabled" : ""}` },
    });
    item.addEventListener("click", () => {
      this.element.value = option.value;
      this.element.dispatchEvent(new Event("change", { bubbles: true }));
      this.menu.hidePopover();
      this.button.focus();
    });
    return item;
  }

  private readonly syncOpenState = (event: ToggleEvent): void => {
    this.button.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "open") focusMenu(this.menu);
  };
  private accessibleName(): string {
    return this.element.getAttribute("aria-label") || Array.from(this.element.labels ?? [], (label) => label.textContent?.trim()).join(" ") || this.element.title || "Options";
  }

  private readonly keydown = (event: KeyboardEvent): void => navigateMenu(this.menu, event);
  private readonly openFromKeyboard = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    this.menu.showPopover();
  };
  private readonly reset = (): void => {
    window.clearTimeout(this.resetTimer);
    this.resetTimer = window.setTimeout(this.sync, 0);
  };

}
