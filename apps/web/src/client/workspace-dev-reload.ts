import { Controller } from "@hotwired/stimulus";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

const devReloadResponseSchema = Type.Object({ revision: Type.Integer({ minimum: 0 }) });
const devReloadRevisionParam = "__agents-in-the-cloud_dev_reload";

class DevReloadController extends Controller {
  static values = { url: String };

  declare readonly urlValue: string;

  private revision: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connected = false;

  connect(): void {
    this.connected = true;
    const url = new URL(window.location.href);
    if (url.searchParams.has(devReloadRevisionParam)) {
      url.searchParams.delete(devReloadRevisionParam);
      window.history.replaceState(window.history.state, "", url);
    }
    void this.poll();
  }

  disconnect(): void {
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    try {
      const response = await fetch(this.urlValue, { cache: "no-store" });
      if (response.ok) {
        const value: unknown = await response.json();
        if (!Value.Check(devReloadResponseSchema, value)) throw new Error("invalid dev reload response");
        if (this.revision !== undefined && value.revision !== this.revision) {
          // A reload cannot participate in a cross-document View Transition, but
          // a same-origin replacement can. The throwaway query makes this a real
          // replacement navigation even though it returns to the same page.
          const url = new URL(window.location.href);
          url.searchParams.set(devReloadRevisionParam, String(value.revision));
          window.location.replace(url);
          return;
        }
        this.revision = value.revision;
      }
    } catch {
    }
    if (this.connected) this.timer = setTimeout(() => void this.poll(), 1_000);
  }
}

export function registerWorkspaceDevReloadController(): void {
  registerWorkspaceControllers({
    "dev-reload": DevReloadController,
  });
}
