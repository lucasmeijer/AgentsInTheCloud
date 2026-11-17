import { Controller } from "@hotwired/stimulus";

export class ConnectionModeSettingsController extends Controller<HTMLElement & { reload(): void }> {
  source?: EventSource;
  connect() {
    this.source = new EventSource("/settings/access/events");
    this.source.addEventListener("access", () => {
      if (this.element.hasAttribute("src")) this.element.reload();
      else this.element.setAttribute("src", "/settings/access");
    });
  }
  disconnect() { this.source?.close(); }
}
