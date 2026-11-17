import { Controller } from "@hotwired/stimulus";

export class ContentRowActionsController extends Controller<HTMLElement> {
  private observer!: ResizeObserver;

  connect(): void {
    const item = this.element.parentElement!;
    this.observer = new ResizeObserver(([entry]) => {
      item.style.setProperty("--content-row-actions-width", `${entry!.borderBoxSize[0]!.inlineSize}px`);
    });
    this.observer.observe(this.element);
  }

  disconnect(): void {
    this.observer.disconnect();
  }
}
