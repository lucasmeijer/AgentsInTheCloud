import { CableTopics, type CableSubscription } from "@agents-in-the-cloud/shared";
import { Controller } from "@hotwired/stimulus";
import { renderCableStreams } from "./cable-stream-renderer.ts";
import { createAgentsInTheCloudCableClient } from "./cable.ts";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

class CableShellController extends Controller<HTMLElement> {
  private subscription?: CableSubscription;
  connect(): void {
    document.addEventListener("live:connection", this.changed);
    document.addEventListener("submit", this.guard, true);
    document.addEventListener("turbo:before-morph-attribute", this.preserveDisclosure);
    document.addEventListener("turbo:before-morph-element", this.skipUnchanged);
    this.subscription = window.AgentsInTheCloudCable!.subscribe(CableTopics.shell());
    this.changed();
  }
  disconnect(): void {
    this.subscription?.unsubscribe();
    document.removeEventListener("live:connection", this.changed);
    document.removeEventListener("submit", this.guard, true);
    document.removeEventListener("turbo:before-morph-attribute", this.preserveDisclosure);
    document.removeEventListener("turbo:before-morph-element", this.skipUnchanged);
  }
  private readonly changed = (): void => {
    const ready = window.AgentsInTheCloudCable!.ready();
    this.element.dataset.liveReady = String(ready);
    const status = document.getElementById("live-connection-status");
    if (status) status.hidden = ready;
  };
  private readonly guard = (event: Event): void => {
    if (!window.AgentsInTheCloudCable!.ready()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  /** Morphing an identical subtree changes nothing, but visits every element and attribute in it
   * with an event: a streamed answer would re-walk all its unchanged blocks on every delivery. */
  private readonly skipUnchanged = (event: Event): void => {
    // SAFETY: Turbo emits this event with its morph descriptor; removals carry no new element.
    const { currentElement, newElement } = (event as CustomEvent<{ currentElement: Element; newElement?: Node }>).detail;
    if (newElement instanceof Element && unchangedSubtree(currentElement, newElement)) event.preventDefault();
  };
  private readonly preserveDisclosure = (event: Event): void => {
    // SAFETY: Turbo emits this event with its attribute mutation descriptor.
    const detail = (event as CustomEvent<{ attributeName: string }>).detail;
    if (event.target instanceof HTMLDetailsElement && detail.attributeName === "open") event.preventDefault();
  };
}
function unchangedSubtree(current: Element, next: Element): boolean {
  if (!current.isEqualNode(next)) return false;
  if (current.matches("input, textarea, select") || current.querySelector("input, textarea, select")) return false;
  return !(current instanceof HTMLTemplateElement || current.querySelector("template")) || current.outerHTML === next.outerHTML;
}

export function installWorkspaceCable(): void {
  window.AgentsInTheCloudCable ??= createAgentsInTheCloudCableClient(renderCableStreams);
  registerWorkspaceControllers({ "cable-shell": CableShellController });
}
