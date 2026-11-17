import { Controller } from "@hotwired/stimulus";

const feedbackDurationMs = 2_000;
const showEvent = "transient-feedback:show";

export function showTransientFeedback(element: HTMLElement): void {
  element.dispatchEvent(new CustomEvent(showEvent));
}

export class TransientFeedbackController extends Controller<HTMLElement> {
  static values = { state: { type: String, default: "initial" } };

  declare stateValue: "initial" | "feedback";
  private timer?: ReturnType<typeof setTimeout>;

  connect(): void {
    this.element.addEventListener(showEvent, this.show);
  }

  disconnect(): void {
    this.element.removeEventListener(showEvent, this.show);
    if (this.timer) clearTimeout(this.timer);
  }

  stateValueChanged(): void {
    this.render();
    if (this.stateValue !== "feedback") return;
    const disableDuringFeedback = this.element instanceof HTMLButtonElement && !this.element.hasAttribute("data-transient-feedback-keep-enabled");
    if (disableDuringFeedback) this.element.disabled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (disableDuringFeedback) this.element.disabled = false;
      this.stateValue = "initial";
      this.timer = undefined;
    }, feedbackDurationMs);
  }

  private readonly show = (): void => {
    this.stateValue = "feedback";
  };

  private render(): void {
    const feedback = this.stateValue === "feedback";
    this.element.querySelector<HTMLElement>(':scope > [data-transient-feedback-content="initial"]')!.hidden = feedback;
    this.element.querySelector<HTMLElement>(':scope > [data-transient-feedback-content="feedback"]')!.hidden = !feedback;
    const label = feedback ? this.element.dataset.transientFeedbackFeedbackLabel : this.element.dataset.transientFeedbackInitialLabel;
    if (label !== undefined) this.element.setAttribute("aria-label", label);
  }
}
