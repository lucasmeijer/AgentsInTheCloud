import { Controller } from "@hotwired/stimulus";
import { copyTextToClipboard } from "@agents-in-the-cloud/shared";
import { showButtonConfirmation } from "../button-confirmation/button-confirmation-controller.ts";

export class CopyButtonController extends Controller<HTMLButtonElement> {
  async copy(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const source = this.element.closest(".copy-region")?.querySelector<HTMLElement>("[data-copy-source]");
    const text = this.element.hasAttribute("data-copy-text") ? this.element.dataset.copyText! : source?.innerText;
    if (text === undefined || (source && !text)) return;
    await copyTextToClipboard(text);
    showButtonConfirmation(this.element);
  }
}
