import { Controller } from "@hotwired/stimulus";
import { PopupPosition } from "../popup/popup-position.ts";

export class HelpTipController extends Controller<HTMLElement> {
  static targets = ["trigger", "text"];
  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly textTarget: HTMLElement;
  private position!: PopupPosition;

  connect(): void {
    this.triggerTarget.popoverTargetElement = this.textTarget;
    this.position = new PopupPosition(this.triggerTarget, this.textTarget);
  }

  disconnect(): void { this.position.disconnect(); }
}
