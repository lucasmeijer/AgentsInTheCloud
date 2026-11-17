import { CableTopics, type CableSubscription } from "@agents-in-the-cloud/shared";
import { Controller } from "@hotwired/stimulus";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

const mounts = new WeakMap<HTMLElement, LiveSurfaceController>();

class LiveSurfaceController extends Controller<HTMLElement> {
  static values = { workspace: String, kind: String, key: String, eager: Boolean };
  declare readonly workspaceValue: string;
  declare readonly kindValue: string;
  declare readonly keyValue: string;
  declare readonly eagerValue: boolean;
  private subscription?: CableSubscription;
  private pending?: ReturnType<typeof Promise.withResolvers<void>>;
  ready = false;

  connect(): void {
    mounts.set(this.element, this);
    if (this.eagerValue) void this.ensureReady();
  }

  disconnect(): void {
    mounts.delete(this.element);
    this.stop();
  }

  release(): void {
    this.stop();
    this.element.replaceChildren();
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.ready = false;
    this.pending?.resolve();
    this.pending = undefined;
  }

  ensureReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.pending) return this.pending.promise;
    const pending = this.pending = Promise.withResolvers<void>();
    if (this.subscription) return pending.promise;
    const identifier = CableTopics.module("surface", this.workspaceValue, { kind: this.kindValue, key: this.keyValue });
    this.subscription = window.AgentsInTheCloudCable!.subscribe(identifier, {
      shownIn: this.element,
      onReady: () => {
        this.ready = true;
        this.pending?.resolve();
        this.pending = undefined;
        this.element.dispatchEvent(new CustomEvent("live:ready", { bubbles: true }));
      },
      onDisconnected: () => { this.ready = false; },
      onRejected: reason => {
        const pending = this.pending;
        const subscription = this.subscription;
        this.pending = undefined;
        this.subscription = undefined;
        this.ready = false;
        subscription?.unsubscribe();
        if (this.kindValue === "workspace" && /^workspace (?:not found|not in registry):/.test(reason)) {
          pending?.resolve();
          this.element.remove();
          return;
        }
        pending?.reject(new Error(reason));
      },
    });
    return pending.promise;
  }
}

export async function prepareLiveSurface(element: HTMLElement): Promise<void> {
  if (!mounts.has(element)) await new Promise<void>(resolve => setTimeout(resolve, 0));
  const mount = mounts.get(element);
  if (!mount) throw new Error(`Live surface did not connect: ${element.id}`);
  await mount.ensureReady();
}

export function liveSurfaceReady(element: HTMLElement): boolean { return mounts.get(element)?.ready ?? false; }
export function registerLiveSurfaces(): void { registerWorkspaceControllers({ "live-surface": LiveSurfaceController }); }

export function releaseLiveSurface(element: HTMLElement): void { mounts.get(element)?.release(); }

export function stopLiveSurface(element: HTMLElement): void { mounts.get(element)?.stop(); }
