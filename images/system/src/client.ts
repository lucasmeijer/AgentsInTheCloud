import { Application, Controller } from "@hotwired/stimulus";
class ProgressController extends Controller<HTMLElement> {
  static values = { events: String, return: Boolean };
  declare eventsValue: string;
  declare returnValue: boolean;
  source?: EventSource;
  connect() {
    this.source = new EventSource(this.eventsValue);
    this.source.addEventListener("progress", (event) => {
      const template = document.createElement("template");
      // SAFETY: EventSource dispatches server-sent events as MessageEvent instances.
      template.innerHTML = (event as MessageEvent<string>).data;
      for (const previous of this.element.querySelectorAll<HTMLDetailsElement>("details[id]")) {
        template.content.querySelector<HTMLDetailsElement>(`#${previous.id}`)!.open = previous.open;
      }
      const focused = document.activeElement;
      const focusedDisclosure = focused?.closest("details")?.id;
      const previousLog = this.element.querySelector<HTMLElement>("[data-progress-log]")!;
      const scrollTop = previousLog.scrollTop;
      const atEnd = previousLog.scrollHeight - scrollTop - previousLog.clientHeight < 20;
      this.element
        .querySelector("[data-progress-content]")!
        .replaceChildren(template.content);
      for (const animation of this.element.getAnimations({ subtree: true })) animation.startTime = 0;
      const nextLog = this.element.querySelector<HTMLElement>("[data-progress-log]")!;
      nextLog.scrollTop = atEnd ? nextLog.scrollHeight : scrollTop;
      if (focusedDisclosure && focused?.tagName === "SUMMARY") {
        this.element.querySelector<HTMLElement>(`#${focusedDisclosure} summary`)!.focus({ preventScroll: true });
      }
    });
    this.source.addEventListener("ready", () => {
      if (this.returnValue) window.location.replace("/");
    });
  }
  disconnect() {
    this.source?.close();
  }
}
const application = Application.start();
application.register("progress", ProgressController);
