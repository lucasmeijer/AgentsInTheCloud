import { Controller } from "@hotwired/stimulus";

export class NavigationOriginController extends Controller {
  connect(): void {
    // Capture also precedes Turbo's stream-response listener. Cancelling alone
    // stops page/frame rendering, but not that listener's stream processing.
    document.addEventListener("turbo:before-fetch-response", this.checkOrigin, true);
  }

  disconnect(): void {
    document.removeEventListener("turbo:before-fetch-response", this.checkOrigin, true);
  }

  private checkOrigin = (event: Event): void => {
    // SAFETY: Turbo dispatches this event with its FetchResponse wrapper.
    const { response } = (event as CustomEvent<{ fetchResponse: { response: Response } }>).detail.fetchResponse;
    const destination = new URL(response.url);
    if (destination.origin === window.location.origin) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(destination.href);
  };
}
