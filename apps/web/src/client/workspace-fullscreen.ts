import { Controller } from "@hotwired/stimulus";
import { workspaceProxyUrl } from "@agents-in-the-cloud/shared";
import { buttonElement } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

type FullscreenMode = "view" | "template" | "media";
type FullscreenMediaElement = HTMLIFrameElement | HTMLImageElement | HTMLVideoElement;
type FullscreenViewer = { element: HTMLElement; disconnect?: () => void };
type FullscreenSession = { owner: AgentsInTheCloudFullscreenController; close(): void };

let hoveredFullscreenControllers: AgentsInTheCloudFullscreenController[] = [];
let fullscreenControllerCount = 0;
let activeFullscreenSession: FullscreenSession | undefined;

function editableShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

function consumeFullscreenShortcut(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) return false;
  if (event.key.toLowerCase() === "f") {
    if (!activeFullscreenSession && !hoveredFullscreenControllers.at(-1)) return false;
    if (editableShortcutTarget(event.target)) return false;
  } else if (event.key !== "Escape" || !activeFullscreenSession) {
    return false;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}

function documentFullscreenKeydown(event: KeyboardEvent): void {
  if (!consumeFullscreenShortcut(event)) return;
  if (activeFullscreenSession) activeFullscreenSession.close();
  else hoveredFullscreenControllers.at(-1)!.open();
}

function pushFullscreenHover(controller: AgentsInTheCloudFullscreenController): void {
  hoveredFullscreenControllers = hoveredFullscreenControllers.filter((candidate) => candidate !== controller);
  hoveredFullscreenControllers.push(controller);
}

function removeFullscreenHover(controller: AgentsInTheCloudFullscreenController): void {
  hoveredFullscreenControllers = hoveredFullscreenControllers.filter((candidate) => candidate !== controller);
}

class AgentsInTheCloudFullscreenController extends Controller<HTMLElement> {
  static values = { mode: String, viewKey: String, title: String, paneHeader: Boolean };
  declare readonly modeValue: FullscreenMode;
  declare readonly viewKeyValue: string;
  declare readonly titleValue: string;
  declare readonly paneHeaderValue: boolean;
  private hoverTarget!: HTMLElement;
  private fullscreenTitle?: HTMLElement;
  private iframeLoadTargets: HTMLIFrameElement[] = [];
  private readonly pointerenter = (): void => pushFullscreenHover(this);
  private readonly pointerleave = (): void => removeFullscreenHover(this);
  private readonly iframeLoaded = (event: Event): void => {
    // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
    const frame = event.currentTarget as HTMLIFrameElement;
    frame.contentDocument?.removeEventListener("keydown", documentFullscreenKeydown, true);
    frame.contentDocument?.addEventListener("keydown", documentFullscreenKeydown, true);
  };

  connect(): void {
    this.hoverTarget = this.paneHeaderValue ? this.element.closest<HTMLElement>(".panel__header")! : this.element;
    this.hoverTarget.addEventListener("pointerenter", this.pointerenter);
    this.hoverTarget.addEventListener("pointerleave", this.pointerleave);
    if (fullscreenControllerCount++ === 0) document.addEventListener("keydown", documentFullscreenKeydown, true);
  }

  titleValueChanged(): void {
    if (this.fullscreenTitle) this.fullscreenTitle.textContent = this.titleValue;
  }

  disconnect(): void {
    removeFullscreenHover(this);
    this.detachIframeShortcuts();
    this.hoverTarget.removeEventListener("pointerenter", this.pointerenter);
    this.hoverTarget.removeEventListener("pointerleave", this.pointerleave);
    if (--fullscreenControllerCount === 0) document.removeEventListener("keydown", documentFullscreenKeydown, true);
    if (activeFullscreenSession?.owner === this) activeFullscreenSession.close();
  }

  open(): void {
    const wasActive = activeFullscreenSession?.owner === this;
    activeFullscreenSession?.close();
    if (wasActive) return;

    if (this.modeValue === "view") this.openLiveView();
    else this.openViewer();
  }

  private openLiveView(): void {
    this.showView();
    const target = this.liveViewTarget();
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    let session: FullscreenSession;
    let bar: HTMLElement;
    const preserveFullscreen = (event: Event): void => {
      if (event.target !== target) return;
      // SAFETY: Turbo supplies the incoming element for morphs, but not removals.
      const { newElement } = (event as CustomEvent<{ newElement?: Element }>).detail;
      if (!(newElement instanceof HTMLElement)) { close(); return; }
      // Fullscreen belongs to this browser session. Merge only its two attributes
      // into incoming markup; all server-owned panel state still updates normally.
      newElement.classList.add("agents-in-the-cloud-fullscreen-live");
      newElement.dataset.agentsInTheCloudFullscreenActive = "true";
    };
    const close = (): void => {
      target.removeEventListener("turbo:before-morph-element", preserveFullscreen);
      this.detachIframeShortcuts();
      target.classList.remove("agents-in-the-cloud-fullscreen-live");
      target.removeAttribute("data-agents-in-the-cloud-fullscreen-active");
      document.body.classList.remove("agents-in-the-cloud-fullscreen-open");
      bar.remove();
      this.fullscreenTitle = undefined;
      if (activeFullscreenSession === session) activeFullscreenSession = undefined;
      previousFocus?.focus({ preventScroll: true });
    };
    bar = this.createBar(close);
    bar.classList.add("agents-in-the-cloud-fullscreen-live-bar");
    document.body.append(bar);
    document.body.classList.add("agents-in-the-cloud-fullscreen-open");
    target.classList.add("agents-in-the-cloud-fullscreen-live");
    target.dataset.agentsInTheCloudFullscreenActive = "true";
    session = { owner: this, close };
    activeFullscreenSession = session;
    target.addEventListener("turbo:before-morph-element", preserveFullscreen);
    this.attachIframeShortcuts(target);
    target.querySelector<HTMLElement>("iframe, .observable-terminal-host, textarea, input, button, [tabindex]")?.focus({ preventScroll: true });
  }

  private openViewer(): void {
    const viewer = this.createViewer();
    const dialog = document.createElement("dialog");
    dialog.className = "agents-in-the-cloud-fullscreen-dialog";
    dialog.setAttribute("aria-label", this.titleValue || "Media preview");
    const surface = document.createElement("div");
    surface.className = "agents-in-the-cloud-fullscreen-surface";
    let session: FullscreenSession;
    const close = (): void => dialog.close();
    surface.append(this.createBar(close), viewer.element);
    dialog.append(surface);
    dialog.addEventListener("close", () => {
      this.detachIframeShortcuts();
      viewer.disconnect?.();
      dialog.remove();
      this.fullscreenTitle = undefined;
      if (activeFullscreenSession === session) activeFullscreenSession = undefined;
    }, { once: true });
    document.body.append(dialog);
    session = { owner: this, close };
    activeFullscreenSession = session;
    dialog.showModal();
    this.attachIframeShortcuts(dialog);
  }

  private createBar(closeFullscreen: () => void): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "agents-in-the-cloud-fullscreen-bar work-view-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Fullscreen controls");

    const title = document.createElement("strong");
    title.className = "agents-in-the-cloud-fullscreen-title";
    title.textContent = this.titleValue;
    this.fullscreenTitle = title;
    const close = buttonElement({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Exit full screen" } });
    close.addEventListener("click", closeFullscreen);
    bar.append(title, close);
    return bar;
  }

  private liveViewTarget(): HTMLElement {
    return this.element.closest<HTMLElement>(".fixed-workspace-presentation")!.querySelector<HTMLElement>(`[data-agents-in-the-cloud-fullscreen-view-key="${CSS.escape(this.viewKeyValue)}"]`)!;
  }

  private showView(): void {
    if (!this.paneHeaderValue) this.element.click();
  }

  private createViewer(): FullscreenViewer {
    if (this.modeValue === "template") {
      const template = this.element.querySelector<HTMLTemplateElement>("template[data-agents-in-the-cloud-fullscreen-target='content']")!;
      const container = document.createElement("div");
      container.className = "agents-in-the-cloud-fullscreen-html";
      container.append(template.content.cloneNode(true));
      return { element: container };
    }
    const media = this.findMedia()!;
    return this.createMediaViewer(media, this.mediaSrc(media));
  }

  private findMedia(): FullscreenMediaElement | undefined {
    if (this.element instanceof HTMLIFrameElement || this.element instanceof HTMLImageElement || this.element instanceof HTMLVideoElement) return this.element;
    return this.element.querySelector<HTMLIFrameElement | HTMLImageElement | HTMLVideoElement>("iframe, img, video") ?? undefined;
  }

  private createMediaViewer(source: FullscreenMediaElement, src: string): FullscreenViewer {
    if (source instanceof HTMLIFrameElement) {
      const frame = document.createElement("iframe");
      frame.className = "agents-in-the-cloud-fullscreen-frame";
      frame.src = src;
      for (const attr of ["sandbox", "allow", "referrerpolicy"] as const) {
        const value = source.getAttribute(attr);
        if (value !== null) frame.setAttribute(attr, value);
      }
      return { element: frame };
    }

    if (source instanceof HTMLVideoElement) {
      const video = document.createElement("video");
      video.className = "agents-in-the-cloud-fullscreen-video";
      video.src = src;
      video.controls = true;
      video.autoplay = !source.paused;
      video.currentTime = source.currentTime;
      video.muted = source.muted;
      video.playbackRate = source.playbackRate;
      return {
        element: video,
        disconnect: () => {
          source.currentTime = video.currentTime;
          if (!video.paused && source.paused) void source.play();
        },
      };
    }

    const image = document.createElement("img");
    image.className = "agents-in-the-cloud-fullscreen-image";
    image.src = src;
    image.alt = source.alt;
    return { element: image };
  }

  private mediaSrc(media: FullscreenMediaElement): string {
    if (media instanceof HTMLImageElement) return media.currentSrc || media.src || this.proxyUrl(media);
    if (media instanceof HTMLVideoElement) return media.currentSrc || media.src || this.proxyUrl(media);
    return media.src || this.proxyUrl(media);
  }

  private proxyUrl(element: HTMLElement): string {
    const workspaceId = element.dataset.agentProxyWorkspaceIdValue!;
    const appKey = element.dataset.agentProxyAppKeyValue!;
    const path = element.dataset.agentProxyPathValue || "/";
    return workspaceProxyUrl(workspaceId, appKey, path);
  }

  private attachIframeShortcuts(root: ParentNode): void {
    this.detachIframeShortcuts();
    this.iframeLoadTargets = [...root.querySelectorAll<HTMLIFrameElement>("iframe")];
    for (const frame of this.iframeLoadTargets) {
      frame.addEventListener("load", this.iframeLoaded);
      frame.contentDocument?.addEventListener("keydown", documentFullscreenKeydown, true);
    }
  }

  private detachIframeShortcuts(): void {
    for (const frame of this.iframeLoadTargets) {
      frame.removeEventListener("load", this.iframeLoaded);
      frame.contentDocument?.removeEventListener("keydown", documentFullscreenKeydown, true);
    }
    this.iframeLoadTargets = [];
  }
}

export function registerWorkspaceFullscreenController(): void {
  registerWorkspaceControllers({
    "agents-in-the-cloud-fullscreen": AgentsInTheCloudFullscreenController,
  });
}
