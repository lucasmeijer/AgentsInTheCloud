import { Controller } from "@hotwired/stimulus";

export class PerimeterButtonController extends Controller<HTMLButtonElement> {
  private observer = new MutationObserver(() => this.syncLabels());

  connect(): void {
    this.syncLabels();
    this.observer.observe(this.element, { attributes: true, attributeFilter: ["data-activity-state", "data-progress-state"] });
  }

  disconnect(): void { this.observer.disconnect(); }

  private syncLabels(): void {
    const state = this.element.dataset.activityState ?? this.element.dataset.progressState;
    for (const content of this.element.querySelectorAll<HTMLElement>(":scope > [data-activity-content], :scope > [data-progress-content]")) {
      content.setAttribute("aria-hidden", String((content.dataset.activityContent ?? content.dataset.progressContent) !== state));
    }
  }
}
