// @ts-expect-error Turbo ships no TypeScript declarations.
import { visit } from "@hotwired/turbo";
import { Controller } from "@hotwired/stimulus";
import { workspaceSelectionController } from "./workspace-controller-registry.ts";

export function restoreAppSettingsDestination(): boolean {
  if (location.pathname !== "/settings") return false;
  if (!document.querySelector('[data-controller~="app-settings"]')) visit(location.href, { action: "replace" });
  return true;
}

export class AppSettingsController extends Controller<HTMLElement> {
  static targets = ["frame", "developer"];
  declare readonly developerTargets: HTMLDetailsElement[];
  private altPressed = false;
  declare readonly frameTarget: HTMLElement;
  private returnUrl = "/";
  private opener?: HTMLElement;

  connect(): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const workspaceId = workspaceSelectionController()?.visibleWorkspaceId();
    this.returnUrl = location.pathname.startsWith("/settings") ? workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}` : "/" : location.href;
    const workspace = document.getElementById("workspace_detail")!;
    workspace.inert = true;
    workspace.setAttribute("aria-hidden", "true");
    document.dispatchEvent(new Event("agents-in-the-cloud:workspace-pane-hidden"));
    this.element.closest(".fixed-shell-app")!.classList.remove("is-mobile-workspace-pane-open");
    this.element.addEventListener("turbo:frame-load", this.frameLoaded);
    document.addEventListener("click", this.outsideAction, true);
    document.addEventListener("turbo:before-stream-render", this.beforeStreamRender);
    document.addEventListener("turbo:before-frame-render", this.beforeFrameRender);
    document.addEventListener("turbo:before-visit", this.beforeVisit);
    document.addEventListener("workspace-selection:before-select", this.beforeSelection);
    window.addEventListener("popstate", this.historyChanged);
    const content = this.frameTarget.querySelector<HTMLElement>("[data-app-settings-location]")!;
    const url = new URL(content.dataset.appSettingsLocation!, location.href).href;
    if (location.href !== url) history.pushState({}, "", url);
    this.focusDestination();
  }

  disconnect(): void {
    this.element.removeEventListener("turbo:frame-load", this.frameLoaded);
    document.removeEventListener("click", this.outsideAction, true);
    document.removeEventListener("turbo:before-stream-render", this.beforeStreamRender);
    document.removeEventListener("turbo:before-frame-render", this.beforeFrameRender);
    document.removeEventListener("turbo:before-visit", this.beforeVisit);
    document.removeEventListener("workspace-selection:before-select", this.beforeSelection);
    window.removeEventListener("popstate", this.historyChanged);
    const workspace = document.getElementById("workspace_detail")!;
    workspace.inert = false;
    workspace.removeAttribute("aria-hidden");
    document.dispatchEvent(new Event("agents-in-the-cloud:workspace-pane-visible"));
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
  }

  developerTargetConnected(target: HTMLDetailsElement): void { target.hidden = !this.altPressed; }
  developerKey(event: KeyboardEvent | FocusEvent): void {
    this.altPressed = event instanceof KeyboardEvent && event.altKey;
    for (const target of this.developerTargets) target.hidden = !this.altPressed;
  }

  close(): void {
    if (!this.element.isConnected) return;
    history.replaceState(history.state, "", this.returnUrl);
    this.element.remove();
  }
  keydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || this.element.querySelector(":popover-open, dialog[open]")) return;
    event.preventDefault();
    this.close();
  }
  private focusDestination(): void {
    const id = this.frameTarget.querySelector<HTMLElement>("[data-app-settings-location]")!.dataset.appSettingsAnchor;
    if (!id) return;
    const anchor = this.frameTarget.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!anchor || anchor.hidden) return;
    requestAnimationFrame(() => {
      const focus = anchor.querySelector<HTMLElement>("summary") ?? anchor;
      if (focus === anchor) focus.tabIndex = -1;
      focus.focus({ preventScroll: true });
      anchor.scrollIntoView({ block: "start" });
    });
  }
  private readonly frameLoaded = (event: Event): void => {
    const target = event.target;
    const anchorId = this.frameTarget.querySelector<HTMLElement>("[data-app-settings-location]")!.dataset.appSettingsAnchor;
    if (target === this.frameTarget || target instanceof HTMLElement && anchorId && target.querySelector(`#${CSS.escape(anchorId)}`)) this.focusDestination();
  };
  private readonly beforeFrameRender = (event: Event): void => {
    if (event.target instanceof HTMLElement && event.target.id === "launch_composer") this.dismissForNavigation();
  };
  private readonly beforeStreamRender = (event: Event): void => {
    // SAFETY: Turbo supplies its stream and awaited renderer.
    const { detail } = event as CustomEvent<{ newStream: HTMLElement; render(stream: HTMLElement): Promise<void> }>;
    if (detail.newStream.getAttribute("target") === "launch_composer") {
      this.dismissForNavigation();
      return;
    }
    if (detail.newStream.getAttribute("target") !== this.frameTarget.id || detail.newStream.getAttribute("action") !== "replace") return;
    const scrollTop = this.frameTarget.querySelector<HTMLElement>(".panel__body")!.scrollTop;
    const render = detail.render;
    detail.render = async stream => {
      await render(stream);
      this.frameTarget.querySelector<HTMLElement>(".panel__body")!.scrollTop = scrollTop;
    };
  };
  private dismissForNavigation(): void {
    this.opener = undefined;
    this.close();
  }
  private readonly outsideAction = (event: MouseEvent): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target.closest("a, button, summary, [data-action]") : null;
    if (target?.closest(".fixed-shell-app") && !this.element.contains(target)) this.dismissForNavigation();
  };
  private readonly beforeVisit = (): void => { this.dismissForNavigation(); };
  private readonly beforeSelection = (): void => { this.dismissForNavigation(); };
  private readonly historyChanged = (): void => {
    if (location.pathname === "/settings") this.frameTarget.setAttribute("src", location.href);
    else this.element.remove();
  };
}
