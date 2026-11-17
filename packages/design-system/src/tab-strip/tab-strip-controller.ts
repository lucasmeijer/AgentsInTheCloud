import { Controller } from "@hotwired/stimulus";
import { scrollGeometry } from "../scrollbar/scroll-geometry.ts";
import type { TabStatus } from "./tab-strip-html.ts";

export function setTabStatus(tab: HTMLElement, state: Pick<TabStatus, "busy" | "requestingAttention">): void {
  const status = tab.querySelector<HTMLElement>(".tab-strip__status")!;
  status.querySelector<HTMLElement>(".running")!.hidden = !state.busy;
  status.querySelector<HTMLElement>(".attention")!.hidden = !state.requestingAttention;
  status.hidden = !state.busy && !state.requestingAttention;
  status.setAttribute("aria-label", [state.busy && "Busy", state.requestingAttention && "Requesting attention"].filter(Boolean).join("; "));
}

export class TabStripController extends Controller<HTMLElement> {
  static targets = ["list"];
  declare listTarget: HTMLElement;
  private resize = new ResizeObserver(() => this.schedule());
  private mutations = new MutationObserver(records => {
    if (records.some(record => record.type === "childList")) this.observeGeometry();
    this.schedule();
  });
  private frame = 0;
  private animationFrame = 0;
  private selected: HTMLElement | null = null;
  private get items() { return [...this.listTarget.querySelectorAll<HTMLElement>(":scope > .content-row:not([hidden])")]; }

  connect(): void {
    this.mutations.observe(this.listTarget, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-selected", "hidden", "dir"] });
    this.observeGeometry();
    document.fonts.addEventListener("loadingdone", this.schedule);
    this.schedule();
  }
  disconnect(): void {
    this.resize.disconnect(); this.mutations.disconnect();
    cancelAnimationFrame(this.frame); cancelAnimationFrame(this.animationFrame);
    document.fonts.removeEventListener("loadingdone", this.schedule);
    this.frame = this.animationFrame = 0;
  }
  private observeGeometry(): void {
    this.resize.disconnect();
    this.resize.observe(this.element);
    for (const slot of this.listTarget.querySelectorAll(".content-row__label, .content-row__icon, .content-row__actions")) this.resize.observe(slot);
  }
  readonly schedule = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.layout(); });
  };
  private layout(): void {
    if (!this.element.clientWidth) return;
    for (const item of this.items) {
      const primary = item.querySelector<HTMLElement>(".content-row__primary")!;
      primary.tabIndex = primary.getAttribute("aria-selected") === "true" ? 0 : -1;
      const icon = item.querySelector<HTMLElement>(".content-row__icon");
      const status = item.querySelector<HTMLElement>(".tab-strip__status")!;
      const actions = item.querySelector<HTMLElement>(".content-row__actions");
      const actionsStyle = actions && getComputedStyle(actions);
      const inlineActions = actionsStyle?.position === "static" && actionsStyle.display !== "none";
      const showStatus = !status.hidden && !inlineActions;
      // Hover-hidden metadata still contributes to preferred width. Close is
      // overlaid on desktop, so engagement never changes the tab's outer size.
      const statusWidth = showStatus ? parseFloat(getComputedStyle(status.firstElementChild!).width) : 0;
      const itemStyle = getComputedStyle(item), primaryStyle = getComputedStyle(primary);
      const padding = [itemStyle.paddingInlineStart, itemStyle.paddingInlineEnd, primaryStyle.paddingInlineStart, primaryStyle.paddingInlineEnd].reduce((sum, value) => sum + parseFloat(value), 0);
      const gaps = parseFloat(primaryStyle.columnGap) * (Number(!!icon) + Number(showStatus));
      const actionWidth = inlineActions ? actions!.getBoundingClientRect().width : 0;
      const natural = Math.ceil(this.titleBounds(item).width + (icon?.getBoundingClientRect().width ?? 0) + statusWidth + padding + gaps + actionWidth);
      item.style.setProperty("--tab-content-width", `${natural}px`);
    }
    const selected = this.items.find(item => item.querySelector('[aria-selected="true"]')) ?? null;
    if (selected !== this.selected) {
      this.selected = selected;
      selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    this.syncScroll(); this.updateTitleFades();
  }
  syncScroll(): void {
    const { maximum, position } = scrollGeometry(this.listTarget, 0);
    this.listTarget.toggleAttribute("data-cut-left", position > 1);
    this.listTarget.toggleAttribute("data-cut-right", maximum - position > 1);
  }
  private titleBounds(item: HTMLElement): DOMRect {
    const range = document.createRange();
    range.selectNodeContents(item.querySelector(".content-row__label-text")!);
    return range.getBoundingClientRect();
  }
  private updateTitleFades(): void {
    for (const item of this.items) {
      const viewport = item.querySelector(".content-row__label")!.getBoundingClientRect();
      const text = this.titleBounds(item);
      item.toggleAttribute("data-title-cut-left", text.left < viewport.left - 1);
      item.toggleAttribute("data-title-cut-right", text.right > viewport.right + 1);
    }
  }
  engage(): void {
    this.schedule();
    if (this.animationFrame) return;
    // Content row's existing hover controller starts its marquee later in the
    // same event bubble. Track the actual moving text edges, not a permanent mask.
    this.animationFrame = requestAnimationFrame(this.animateFades);
  }
  private readonly animateFades = (): void => {
    this.animationFrame = 0;
    if (!this.element.clientWidth) return;
    this.updateTitleFades();
    if (this.listTarget.querySelector(".is-label-scrolling") && !matchMedia("(prefers-reduced-motion: reduce)").matches) this.animationFrame = requestAnimationFrame(this.animateFades);
  };
  navigate(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tab = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="tab"]') : null;
    if (!tab) return;
    const tabs = this.items.map(item => item.querySelector<HTMLElement>('[role="tab"]')!).filter(item => !item.matches(':disabled, [aria-disabled="true"]'));
    if (tabs.length < 2) return;
    event.preventDefault();
    const direction = (event.key === "ArrowRight" ? 1 : -1) * (getComputedStyle(this.listTarget).direction === "rtl" ? -1 : 1);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(tab) + direction + tabs.length) % tabs.length;
    tabs[next]!.click(); tabs[next]!.focus();
  }
}
