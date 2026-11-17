import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@agents-in-the-cloud/shared";

const fadeDuration = 240;
interface Arrival { start: number; end: number; time: number }

export function createAgentStreamingTextController(Controller: StimulusControllerConstructor) {
  return class AgentStreamingTextController extends Controller {
    declare readonly element: HTMLElement;
    private text = "";
    private arrivals: Arrival[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    private readonly observer = new MutationObserver(() => this.refresh());

    connect(): void {
      this.text = this.textNodes().map((node) => node.data).join("");
      this.observe();
      this.reducedMotion.addEventListener("change", this.refresh);
    }

    private observe(): void {
      this.observer.observe(this.element, { childList: true, subtree: true, characterData: true });
    }

    private textNodes(): Text[] {
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement!;
          return parent.closest("p, li, h1, h2, h3, h4, h5, h6, td, th")
            && !parent.closest("pre, button, svg, template, [hidden], .agent-media-frame")
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      while (walker.nextNode()) {
        // SAFETY: SHOW_TEXT restricts the walker to Text nodes.
        nodes.push(walker.currentNode as Text);
      }
      return nodes;
    }

    private unwrap(): void {
      for (const span of this.element.querySelectorAll(".agent-stream-arrival")) {
        const parent = span.parentNode!;
        span.replaceWith(...span.childNodes);
        parent.normalize();
      }
    }

    private readonly refresh = (): void => {
      this.observer.disconnect();
      clearTimeout(this.timer);
      this.unwrap();
      const nodes = this.textNodes();
      const text = nodes.map((node) => node.data).join("");
      const now = performance.now();
      let prefix = 0;
      while (prefix < this.text.length && prefix < text.length && this.text[prefix] === text[prefix]) prefix++;
      let suffix = 0;
      while (suffix < this.text.length - prefix && suffix < text.length - prefix
        && this.text[this.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
      this.arrivals = this.arrivals.filter((arrival) => arrival.end <= prefix && now - arrival.time < fadeDuration);
      if (text.length - suffix > prefix) this.arrivals.push({ start: prefix, end: text.length - suffix, time: now });
      this.text = text;
      if (this.reducedMotion.matches) this.arrivals = [];

      const newestFirst = this.arrivals.toReversed();
      let offset = 0;
      for (const node of nodes) {
        const end = offset + node.length;
        for (const arrival of newestFirst) {
          const start = Math.max(offset, arrival.start);
          const stop = Math.min(end, arrival.end);
          if (start >= stop) continue;
          node.splitText(stop - offset);
          const entering = node.splitText(start - offset);
          const span = document.createElement("span");
          span.className = "agent-stream-arrival";
          span.style.animationDuration = `${fadeDuration}ms`;
          span.style.animationDelay = `${arrival.time - now}ms`;
          entering.replaceWith(span);
          span.append(entering);
        }
        offset = end;
      }
      if (this.arrivals.length) {
        this.timer = setTimeout(this.refresh, fadeDuration - (now - this.arrivals[0]!.time));
      }
      this.observe();
    };

    disconnect(): void {
      this.observer.disconnect();
      this.reducedMotion.removeEventListener("change", this.refresh);
      clearTimeout(this.timer);
      this.unwrap();
      this.arrivals = [];
    }
  };
}
