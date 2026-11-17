import { Controller } from "@hotwired/stimulus";

export class DialogController extends Controller<HTMLDialogElement> {
  private opener?: HTMLElement;

  connect(): void {
    this.element.addEventListener("beforetoggle", this.captureOpener);
    this.element.addEventListener("close", this.restoreFocus);
    if (this.element.hasAttribute("data-dialog-auto-show") && !this.element.open) {
      this.element.showModal();
      requestAnimationFrame(() => (this.element.querySelector<HTMLElement>("[autofocus]") ?? this.element.querySelector<HTMLElement>("button, input, select, textarea"))?.focus());
    }
  }

  disconnect(): void {
    this.element.removeEventListener("beforetoggle", this.captureOpener);
    this.element.removeEventListener("close", this.restoreFocus);
  }

  private readonly captureOpener = (event: Event): void => {
    // SAFETY: Native dialog beforetoggle events implement the ToggleEvent contract.
    if ((event as ToggleEvent).newState === "open") {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    }
  };

  private readonly restoreFocus = (): void => {
    this.opener?.focus();
  };

  close(): void {
    this.element.close();
  }

  submitted(event: Event): void {
    // SAFETY: Turbo submit events expose an optional `{ success?: boolean }` detail contract.
    const detail = (event as CustomEvent).detail as { success?: boolean } | undefined;
    if (detail?.success === false) return;
    this.element.close();
  }
}
