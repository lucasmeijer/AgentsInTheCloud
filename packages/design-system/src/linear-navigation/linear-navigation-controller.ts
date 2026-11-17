import { Controller } from "@hotwired/stimulus";

const enabledItemSelector = ':not([hidden]):not(:disabled):not([aria-disabled="true"])';

export class LinearNavigationController extends Controller<HTMLElement> {
  static targets = ["item"];
  declare readonly itemTargets: HTMLElement[];

  connect(): void {
    this.element.addEventListener("keydown", this.navigate);
  }

  disconnect(): void {
    this.element.removeEventListener("keydown", this.navigate);
  }

  private readonly navigate = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = this.itemTargets.filter((item) => item.matches(enabledItemSelector));
    const current = event.target instanceof HTMLElement ? items.indexOf(event.target) : -1;
    if (current < 0) return;
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const next = items[current + offset];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
}
