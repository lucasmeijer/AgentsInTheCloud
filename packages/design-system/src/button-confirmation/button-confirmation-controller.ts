import { Controller } from "@hotwired/stimulus";

const showEvent = "button-confirmation:show";
const confirmationDurationMs = 1_200;

export function showButtonConfirmation(button: HTMLButtonElement): void {
  button.dispatchEvent(new Event(showEvent));
}

export function resetButtonConfirmation(button: HTMLButtonElement): void {
  button.dataset.buttonConfirmationConfirmedValue = "false";
}

export class ButtonConfirmationController extends Controller<HTMLButtonElement> {
  static targets = ["initial", "check"];
  static values = { confirmed: Boolean, label: String, confirmedLabel: String };
  declare readonly initialTarget: HTMLElement;
  declare readonly checkTarget: HTMLElement;
  declare confirmedValue: boolean;
  declare readonly labelValue: string;
  declare readonly confirmedLabelValue: string;
  private timer?: ReturnType<typeof setTimeout>;

  connect(): void {
    this.element.addEventListener(showEvent, this.show);
    this.element.addEventListener("animationend", this.returned);
    this.element.addEventListener("animationcancel", this.returned);
    if (this.confirmedValue && this.timer === undefined) this.startTimer();
  }

  disconnect(): void {
    this.element.removeEventListener(showEvent, this.show);
    this.element.removeEventListener("animationend", this.returned);
    this.element.removeEventListener("animationcancel", this.returned);
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  confirmedValueChanged(_confirmed: boolean, previous: boolean): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.element.toggleAttribute("data-button-confirmation-returning", !this.confirmedValue && previous && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.initialTarget.setAttribute("aria-hidden", String(this.confirmedValue));
    this.checkTarget.setAttribute("aria-hidden", String(!this.confirmedValue));
    this.element.setAttribute("aria-label", this.confirmedValue ? this.confirmedLabelValue : this.labelValue);
    if (this.confirmedValue) this.startTimer();
  }

  private startTimer(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.confirmedValue = false; }, confirmationDurationMs);
  }

  private readonly show = (): void => {
    if (this.confirmedValue) this.startTimer();
    else this.confirmedValue = true;
  };

  private readonly returned = (event: AnimationEvent): void => {
    if (event.target === this.element && event.animationName === "button-confirmation-settle") this.element.removeAttribute("data-button-confirmation-returning");
  };
}
