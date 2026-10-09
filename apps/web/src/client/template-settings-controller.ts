// @ts-expect-error Turbo ships no TypeScript declarations.
import { visit } from "@hotwired/turbo";
import { Controller } from "@hotwired/stimulus";
import type { SettingsEditorController, SettingsEditorLoadedEvent } from "./settings-editor-controller.ts";
import type { WorkspaceSelectionEvent } from "./workspace-residency.ts";
import { residencyController } from "./workspace-controller-registry.ts";

const templateSettingsPath = /^\/workspace-templates\/[^/]+\/settings$/;

/** Reopen a settings destination when browser history reaches it after the panel was closed. */
export function restoreTemplateSettingsDestination(): boolean {
  if (!templateSettingsPath.test(location.pathname)) return false;
  if (!document.querySelector('[data-controller~="template-settings"]')) visit(location.href, { action: "replace" });
  return true;
}

/** Template settings panel: history, focus return and discarding drafts on navigation. Editing belongs to settings-editor. */
export class TemplateSettingsController extends Controller<HTMLElement> {
  static targets = ["discard", "developer"];
  static outlets = ["settings-editor"];
  declare readonly developerTargets: HTMLElement[];
  declare readonly discardTarget: HTMLDialogElement;
  declare readonly settingsEditorOutlet: SettingsEditorController;
  private altPressed = false;
  private returnUrl = "/";
  private currentUrl = "";
  private opener?: HTMLElement;
  private pending?: () => void;
  private bypass = false;
  private restoring = false;

  connect(): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const workspaceId = residencyController()?.visibleWorkspaceId();
    this.returnUrl = location.pathname.includes("/workspace-templates/") ? workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}` : "/" : location.href;
    this.currentUrl = new URL(this.element.querySelector<HTMLElement>("[data-settings-editor-location]")!.dataset.settingsEditorLocation!, location.href).href;
    if (!templateSettingsPath.test(location.pathname)) history.pushState({}, "", this.currentUrl);
    else history.replaceState({}, "", this.currentUrl);
    const workspace = document.getElementById("workspace_detail")!;
    workspace.inert = true;
    workspace.setAttribute("aria-hidden", "true");
    document.dispatchEvent(new Event("agents-in-the-cloud:workspace-pane-hidden"));
    // Settings occupies the main destination on phones, rather than the workspace picker slide.
    this.element.closest(".fixed-shell-app")!.classList.remove("is-mobile-workspace-pane-open");
    document.addEventListener("click", this.navigate, true);
    document.addEventListener("turbo:before-visit", this.beforeVisit);
    document.addEventListener("turbo:before-render", this.beforeRender);
    document.addEventListener("workspace-residency:before-select", this.beforeWorkspaceSelection);
    window.addEventListener("beforeunload", this.beforeUnload);
    window.addEventListener("popstate", this.historyChanged, true);
  }

  disconnect(): void {
    document.removeEventListener("click", this.navigate, true);
    document.removeEventListener("turbo:before-visit", this.beforeVisit);
    document.removeEventListener("turbo:before-render", this.beforeRender);
    document.removeEventListener("workspace-residency:before-select", this.beforeWorkspaceSelection);
    window.removeEventListener("beforeunload", this.beforeUnload);
    window.removeEventListener("popstate", this.historyChanged, true);
    const replacement = document.getElementById(this.element.id);
    if (!replacement?.hasAttribute("data-controller")) {
      const workspace = document.getElementById("workspace_detail")!;
      workspace.inert = false;
      workspace.removeAttribute("aria-hidden");
      document.dispatchEvent(new Event("agents-in-the-cloud:workspace-pane-visible"));
      if (templateSettingsPath.test(location.pathname)) history.replaceState(history.state, "", this.returnUrl);
      if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    }
  }

  developerTargetConnected(target: HTMLElement): void { target.hidden = !this.altPressed; }
  developerKey(event: KeyboardEvent | FocusEvent): void {
    this.altPressed = event instanceof KeyboardEvent && event.altKey;
    for (const target of this.developerTargets) target.hidden = !this.altPressed;
  }

  /** Each rendered settings page has its own history entry; saves replace it. */
  loaded(event: SettingsEditorLoadedEvent): void {
    this.currentUrl = event.detail.location;
    if (event.detail.submitted || this.restoring) history.replaceState({}, "", this.currentUrl);
    else if (location.href !== this.currentUrl) history.pushState({}, "", this.currentUrl);
    this.restoring = false;
  }

  private get editor(): SettingsEditorController { return this.settingsEditorOutlet; }
  private guard(action: () => void): void {
    if (this.editor.busy) return;
    if (!this.editor.dirty()) { action(); return; }
    this.pending = action;
    this.discardTarget.showModal();
  }
  stay(event?: Event): void {
    event?.preventDefault();
    this.pending = undefined;
    this.discardTarget.close();
    this.editor.resumeAutosaves();
  }
  discard(): void {
    const action = this.pending!;
    this.pending = undefined;
    this.discardTarget.close();
    this.editor.markClean();
    action();
  }
  close(): void { this.guard(() => this.leave()); }
  keydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || this.discardTarget.open || this.element.querySelector(":popover-open")) return;
    event.preventDefault();
    this.close();
  }
  private leave(): void {
    history.replaceState(history.state, "", this.returnUrl);
    const host = document.createElement("div");
    host.id = this.element.id;
    this.element.replaceWith(host);
  }

  private readonly navigate = (event: MouseEvent): void => {
    if (this.bypass || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("a[href], [data-workspace-entry-id]") : null;
    if (!target || target.closest("dialog")) return;
    const inside = this.element.contains(target);
    if (event.altKey && !(inside && target.closest('[data-template-settings-target="developer"]'))) return;
    // Normal links opening another tab do not abandon the current draft.
    if (target instanceof HTMLAnchorElement && target.target === "_blank") return;
    const action = (): void => {
      if (!inside) this.leave();
      this.bypass = true;
      target.click();
      this.bypass = false;
    };
    // Turbo ignores Alt-clicks; the revealed developer entry uses the same replay path.
    if (event.altKey || this.editor.busy || this.editor.dirty() || !inside) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.guard(action);
    }
  };
  private readonly beforeWorkspaceSelection = (event: Event): void => {
    if (!this.element.isConnected) return;
    event.preventDefault();
    // SAFETY: Workspace residency owns the event and its continuation contract.
    const selection = event as WorkspaceSelectionEvent;
    this.guard(() => { this.leave(); void selection.detail.resume(); });
  };
  private readonly beforeVisit = (event: Event): void => {
    if (this.bypass || !this.editor.dirty()) return;
    event.preventDefault();
    // SAFETY: turbo:before-visit supplies its browser destination in detail.url.
    const url = (event as CustomEvent<{ url: string }>).detail.url;
    this.guard(() => { this.leave(); visit(url); });
  };
  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.editor.dirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  private restore(destination: string): void {
    if (new URL(destination).pathname === new URL(this.currentUrl).pathname) {
      this.restoring = true;
      this.editor.reload(destination);
    } else {
      this.leave();
      visit(destination, { action: "replace" });
    }
  }
  private readonly beforeRender = (event: Event): void => {
    if (!this.editor.dirty()) return;
    event.preventDefault();
    // SAFETY: Turbo's cancelable render event supplies the suspended render's resume callback.
    const resume = (event as CustomEvent<{ resume(): void }>).detail.resume;
    if (!this.discardTarget.open) this.guard(resume);
  };
  private readonly historyChanged = (event: PopStateEvent): void => {
    const destination = location.href;
    if (this.editor.dirty()) {
      event.stopImmediatePropagation();
      history.replaceState({}, "", this.currentUrl);
      this.guard(() => this.restore(destination));
    } else if (new URL(destination).pathname === new URL(this.currentUrl).pathname) {
      event.stopImmediatePropagation();
      this.restore(destination);
    } else {
      this.returnUrl = destination;
      this.leave();
    }
  };
}
