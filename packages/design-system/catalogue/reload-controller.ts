import { Controller } from "@hotwired/stimulus";

export class CatalogueReloadController extends Controller {
  static values = { url: String };
  declare urlValue: string;
  private revision?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private connected = false;

  connect(): void {
    this.connected = true;
    void this.poll();
  }

  disconnect(): void {
    this.connected = false;
    clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    // A dev server intentionally goes offline during a source rebuild. Retry only
    // connection failures; malformed responses and server errors remain visible.
    const response = await fetch(this.urlValue, { cache: "no-store" }).catch(() => undefined);
    if (response) {
      if (!response.ok) throw new Error(`Catalogue reload endpoint: ${response.status}`);
      const value = await response.json();
      if (!Number.isSafeInteger(value.revision)) throw new Error("Invalid catalogue reload revision");
      if (this.revision !== undefined && this.revision !== value.revision) {
        window.location.reload();
        return;
      }
      this.revision = value.revision;
    }
    if (this.connected) this.timer = setTimeout(() => void this.poll(), 1000);
  }
}
