import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@agents-in-the-cloud/shared";

export function createAgentTailFrameController(Controller: StimulusControllerConstructor) {
  return class AgentTailFrameController extends Controller {
    declare readonly element: HTMLElement;
    private previous?: {
      scrollerIndex: number;
      height: number;
      top: number;
      tail: boolean;
      transcript?: { element: HTMLElement; top: number };
    };
    private scrollers(): HTMLElement[] {
      return [...this.element.querySelectorAll<HTMLElement>(".agent-tail-output")];
    }
    prepare(event: Event): void {
      if (!(event.currentTarget instanceof HTMLAnchorElement)) throw new Error("Agent tail pagination action requires a link");
      const scrollers = this.scrollers();
      const scroller = event.currentTarget.closest<HTMLElement>(".agent-tail-output");
      if (!scroller) throw new Error("Agent tail pagination link requires an output container");
      const transcript = this.element.closest<HTMLElement>(".agent-transcript");
      this.previous = {
        scrollerIndex: scrollers.indexOf(scroller),
        height: scroller.scrollHeight,
        top: scroller.scrollTop,
        tail: scroller.dataset.agentTailDirection === "last",
        transcript: transcript ? { element: transcript, top: transcript.scrollTop } : undefined,
      };
    }
    loaded(): void {
      const previous = this.previous;
      this.previous = undefined;
      if (!previous) {
        for (const scroller of this.element.querySelectorAll<HTMLElement>('.agent-tail-output[data-agent-tail-direction="last"]')) scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      const scroller = this.scrollers()[previous.scrollerIndex];
      if (!scroller) return;
      scroller.scrollTop = previous.tail ? previous.top + scroller.scrollHeight - previous.height : previous.top;
      if (previous.transcript) {
        previous.transcript.element.scrollTop = previous.transcript.top;
        previous.transcript.element.dispatchEvent(new Event("scroll"));
      }
    }
  };
}

export function createAgentLazyDetailController(Controller: StimulusControllerConstructor) {
  return class AgentLazyDetailController extends Controller {
    static targets = ["frame"];
    declare readonly element: HTMLDetailsElement;
    declare readonly frameTarget: HTMLElement & { src: string };

    connect(): void { if (this.element.open) this.load(); }
    load(): void {
      if (this.frameTarget.getAttribute("src")) return;
      this.frameTarget.setAttribute("src", this.frameTarget.dataset.src!);
    }
  };
}

