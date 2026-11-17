import { Controller } from "@hotwired/stimulus";
import { PopupPosition } from "../popup/popup-position.ts";

export class DestructiveConfirmationController extends Controller<HTMLElement> {
  private triggerButton!: HTMLButtonElement;
  private confirmation!: HTMLElement;
  private initialLabel: string | null = null;
  private initialVariant!: string;
  private position!: PopupPosition;
  private entrance?: Animation;

  connect(): void {
    this.triggerButton = this.element.querySelector<HTMLButtonElement>(".destructive-confirmation__trigger")!;
    this.confirmation = this.element.querySelector<HTMLElement>(".destructive-confirmation__confirm")!;
    this.initialLabel = this.triggerButton.getAttribute("aria-label");
    this.initialVariant = ["primary", "secondary", "danger"].find((variant) => this.triggerButton.classList.contains(variant))!;
    this.position = new PopupPosition(this.triggerButton, this.confirmation, "adjacent");
    this.confirmation.addEventListener("beforetoggle", this.prepareState);
    this.confirmation.addEventListener("toggle", this.syncOpenState);
  }

  preserveOpenState(event: Event): void {
    if (event.target === this.element && this.confirmation.matches(":popover-open")) event.preventDefault();
  }

  disconnect(): void {
    this.finishEntrance();
    this.position.disconnect();
    this.confirmation.removeEventListener("beforetoggle", this.prepareState);
    this.confirmation.removeEventListener("toggle", this.syncOpenState);
  }

  private readonly prepareState = (event: ToggleEvent): void => {
    this.finishEntrance();
    const confirming = event.newState === "open";
    this.confirmation.inert = !confirming;
    this.triggerButton.setAttribute("aria-expanded", String(confirming));
    this.triggerButton.classList.replace(confirming ? this.initialVariant : "secondary", confirming ? "secondary" : this.initialVariant);
    const label = confirming ? this.element.dataset.destructiveConfirmationCancelCaption! : this.initialLabel;
    for (const attribute of ["aria-label", "title"]) {
      if (label === null) this.triggerButton.removeAttribute(attribute);
      else this.triggerButton.setAttribute(attribute, label);
    }
  };

  private readonly syncOpenState = (): void => {
    if (this.confirmation.matches(":popover-open")) {
      this.triggerButton.focus({ preventScroll: true });
      this.animateEntrance();
    }
  };

  private animateEntrance(): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const style = getComputedStyle(this.confirmation);
    this.confirmation.inert = true;
    this.entrance = this.confirmation.animate([
      { transform: "scale(.96)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ], {
      duration: Number.parseFloat(style.getPropertyValue("--motion-enter")),
      easing: style.getPropertyValue("--motion-ease-out").trim(),
    });
    this.entrance.onfinish = () => this.finishEntrance();
  }

  private finishEntrance(): void {
    this.entrance?.cancel();
    this.entrance = undefined;
    this.confirmation.inert = false;
  }
}
