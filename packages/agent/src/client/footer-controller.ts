import type { WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";

export function createAgentFooterController(Controller: WorkspaceClientControllerConstructor) {
  return class AgentFooterController extends Controller {
    private resizeObserver!: ResizeObserver;
    private mutationObserver!: MutationObserver;
    private frame = 0;

    connect(): void {
      this.resizeObserver = new ResizeObserver(this.schedule);
      this.resizeObserver.observe(this.element);
      this.mutationObserver = new MutationObserver(this.schedule);
      this.mutationObserver.observe(this.element, { childList: true, subtree: true, characterData: true });
      document.fonts.addEventListener("loadingdone", this.schedule);
    }

    disconnect(): void {
      this.resizeObserver.disconnect();
      this.mutationObserver.disconnect();
      document.fonts.removeEventListener("loadingdone", this.schedule);
      cancelAnimationFrame(this.frame);
    }

    private schedule = (): void => {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.layout());
    };

    private layout(): void {
      // SAFETY: agent-footer is attached to the server-rendered footer div.
      const footer = this.element as HTMLElement;
      const items = [...footer.querySelectorAll<HTMLElement>("[data-footer-drop]")];
      const thinking = footer.querySelector<HTMLElement>(".composer-selection-field");
      for (const item of items) item.hidden = false;
      if (thinking) {
        thinking.hidden = false;
        thinking.style.maxWidth = "";
      }
      const style = getComputedStyle(footer);
      const available = footer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const children = [...footer.querySelectorAll<HTMLElement>(":scope > :not([hidden])")];
      const gap = parseFloat(style.columnGap);
      const required = (): number => {
        const visible = children.filter((child) => !child.hidden);
        return visible.reduce((width, child) => width + child.getBoundingClientRect().width, 0)
          + Math.max(0, visible.length - 1) * gap;
      };
      const priorities = [...new Set(items.map((item) => Number(item.dataset.footerDrop)))].sort((a, b) => a - b);
      for (const priority of priorities) {
        if (required() <= available) break;
        for (const item of items) {
          if (Number(item.dataset.footerDrop) === priority) item.hidden = true;
        }
      }
      if (thinking && required() > available) {
        const width = thinking.getBoundingClientRect().width - (required() - available);
        thinking.hidden = width < thinking.getBoundingClientRect().height;
        if (!thinking.hidden) thinking.style.maxWidth = `${width}px`;
      }
      footer.style.overflowX = required() > available ? "auto" : "hidden";
    }
  };
}
