import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";

const publicKeySchema = Type.Object({ publicKey: Type.String() });

export function createAgentNotificationsController(Controller: WorkspaceClientControllerConstructor) {
  return class AgentNotificationsController extends Controller {
    static targets = ["feedback", "message"];
    declare readonly element: HTMLElement;
    declare readonly feedbackTarget: HTMLElement;
    declare readonly messageTarget: HTMLElement;
    private pending = false;

    dismiss(): void {
      this.feedbackTarget.hidden = true;
      this.element.querySelector<HTMLButtonElement>('[data-notification-url]')?.focus();
    }

    private async subscribe(): Promise<PushSubscription> {
      if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Notifications require HTTPS and a supported browser. On iOS 16.4 or later, add AgentsInTheCloud to your Home Screen and open it from there.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notifications are not allowed. Enable them for AgentsInTheCloud in your device settings, then try again.");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) return subscription;

      const response = await fetch("/agent-notifications/public-key");
      if (!response.ok) throw new Error("Could not configure notifications. Please try again.");
      const { publicKey } = Value.Parse(publicKeySchema, await response.json());
      const bytes = Uint8Array.from(atob(publicKey.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
      return await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    }

    async toggle(event: Event): Promise<void> {
      // SAFETY: This Stimulus action is attached only to the server-rendered notification button.
      const button = event.currentTarget as HTMLButtonElement;
      if (this.pending) return;
      const { notificationUrl: url, notificationTurn: turnId, notificationArmed: armed } = button.dataset;
      const enabled = armed !== "true";
      this.pending = true;
      this.feedbackTarget.hidden = true;
      button.setAttribute("aria-busy", "true");
      try {
        const subscription = enabled ? await this.subscribe() : undefined;
        const response = await fetch(url!, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "text/vnd.turbo-stream.html" },
          body: JSON.stringify({ turnId, enabled, subscription: subscription?.toJSON() }),
        });
        if (!response.headers.get("content-type")?.includes("text/vnd.turbo-stream.html")) {
          throw new Error("Could not change the notification. Please try again.");
        }
        window.Turbo!.renderStreamMessage(await response.text());
      } catch (error) {
        this.messageTarget.setAttribute("role", "alert");
        this.messageTarget.textContent = error instanceof Error ? error.message : "Could not enable notifications.";
        this.feedbackTarget.hidden = false;
      } finally {
        button.removeAttribute("aria-busy");
        this.pending = false;
      }
    }
  };
}
