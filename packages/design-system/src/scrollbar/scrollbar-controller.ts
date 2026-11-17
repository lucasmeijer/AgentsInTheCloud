import { Controller } from "@hotwired/stimulus";
import { scrollGeometry, setScrollPosition } from "./scroll-geometry.ts";

/** Two reusable top-layer overlays follow the hovered native scroll viewport.
 * No wrappers or children are inserted into feature layouts (including editors).
 * Touch, keyboard and scrollIntoView stay native; horizontal-only regions
 * translate vertical mouse-wheel input. Touch scrolling (including momentum)
 * reveals the scrolled viewport's tracks until scrolling settles.
 */
export class ScrollbarController extends Controller<HTMLElement> {
  private viewport: HTMLElement | null = null;
  private tracks: HTMLElement[] = [];
  private frame = 0;
  private drag: { axis: number; pointer: number; origin: number; position: number } | null = null;
  private touching = false;
  private settle = 0;

  connect(): void {
    for (const axis of [0, 1]) {
      const track = document.createElement("div");
      track.className = `scrollbar scrollbar--${axis ? "vertical" : "horizontal"}`;
      track.setAttribute("popover", "manual");
      track.setAttribute("aria-hidden", "true");
      track.dataset.action = "pointerdown->scrollbars#start pointermove->scrollbars#move pointerup->scrollbars#end pointercancel->scrollbars#end lostpointercapture->scrollbars#end";
      track.append(document.createElement("span"));
      this.element.append(track);
      this.tracks.push(track);
    }
  }
  disconnect(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.settle);
    this.settle = 0;
    this.tracks.forEach(track => track.remove());
    this.tracks = [];
    this.viewport = null;
    this.drag = null;
    this.frame = 0;
  }
  // Bound to pointermove, not pointerover: scrolling content under a stationary
  // cursor must not change which viewport owns the visible tracks.
  hover(event: PointerEvent): void {
    if (this.drag || event.pointerType === "touch") return;
    clearTimeout(this.settle);
    this.settle = 0;
    this.viewport = this.findViewport(event.target, true) ?? document.documentElement;
    if (!this.frame) this.update();
  }
  touchStart(): void {
    this.touching = true;
    if (!this.settle) this.hide();
  }
  touchEnd(): void {
    this.touching = false;
  }
  // Scroll events don't bubble; this is bound in the capture phase on document.
  // Only scrolling during or straight after a touch counts, so programmatic
  // scrolling (e.g. following a streaming transcript) stays quiet.
  scroll(event: Event): void {
    if (this.drag || (!this.touching && !this.settle)) return;
    const target = event.target === document ? document.documentElement : event.target;
    if (!(target instanceof HTMLElement)) return;
    this.viewport = target;
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => { this.settle = 0; this.hide(); }, 700);
    if (!this.frame) this.update();
  }
  wheel(event: WheelEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) return;
    const viewport = this.findViewport(event.target);
    if (!viewport) return;
    const vertical = scrollGeometry(viewport, 1);
    if (vertical.scrollable && vertical.maximum > 1) return;
    const geometry = scrollGeometry(viewport, 0);
    const delta = event.deltaY * (geometry.reversed ? -1 : 1) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? geometry.size : 1);
    event.preventDefault();
    setScrollPosition(viewport, 0, geometry.position + delta);
  }
  private findViewport(target: EventTarget | null, includeEmpty = false): HTMLElement | null {
    let node = target instanceof Element ? (target instanceof HTMLElement ? target : target.parentElement) : null;
    if (node?.closest(".scrollbar")) return this.viewport;
    let nearest: HTMLElement | null = null;
    for (; node; node = node.parentElement) {
      const horizontal = scrollGeometry(node, 0), vertical = scrollGeometry(node, 1);
      if (horizontal.scrollable || vertical.scrollable) nearest ??= node;
      if ((horizontal.scrollable && horizontal.maximum > 1) || (vertical.scrollable && vertical.maximum > 1)) return node;
    }
    // Empty nested code regions must not steal an ancestor's track. If nothing
    // scrolls yet, retain a candidate so its thumb can appear as content grows.
    return includeEmpty ? nearest : null;
  }

  leave(event?: PointerEvent): void {
    if (event?.pointerType === "touch") return;
    this.hide();
  }
  private hide(): void {
    if (this.drag) return;
    this.viewport = null;
    clearTimeout(this.settle);
    this.settle = 0;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.tracks.forEach(track => track.togglePopover(false));
  }
  private readonly update = (): void => {
    this.frame = 0;
    const viewport = this.viewport;
    if (!viewport?.isConnected) { this.hide(); return; }
    const root = viewport === document.documentElement;
    const rect = root ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : viewport.getBoundingClientRect();
    let left = Math.max(0, rect.left + viewport.clientLeft), top = Math.max(0, rect.top + viewport.clientTop);
    let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    // Top-layer tracks must still respect clipping scroll ancestors. Ancestors
    // above a fixed-position element (e.g. a fullscreen pane) don't clip it.
    for (let parent = viewport.parentElement, escaped = getComputedStyle(viewport).position === "fixed"; parent && parent !== document.body && !escaped; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (style.overflowX !== "visible") { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (style.overflowY !== "visible") { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      escaped = style.position === "fixed";
    }
    this.tracks.forEach((track, axis) => {
      const { size, total, maximum, position, scrollable } = scrollGeometry(viewport, axis);
      const length = axis ? bottom - top : right - left;
      const visible = scrollable && maximum > 1 && length > 12;
      track.togglePopover(visible);
      if (!visible) return;
      const thumb = Math.min(length - 1, Math.max(28, length * size / total));
      track.style.left = `${axis ? right - 12 : left}px`;
      track.style.top = `${axis ? top : bottom - 12}px`;
      track.style.width = `${axis ? 12 : length}px`;
      track.style.height = `${axis ? length : 12}px`;
      track.style.setProperty("--scrollbar-size", `${thumb}px`);
      track.style.setProperty("--scrollbar-offset", `${position / maximum * (length - thumb)}px`);
    });
    this.frame = requestAnimationFrame(this.update);
  };
  start(event: PointerEvent): void {
    if (event.button !== 0) return;
    // SAFETY: this action is bound exclusively to the HTMLElement tracks created in connect.
    const track = event.currentTarget as HTMLElement;
    const axis = this.tracks.indexOf(track);
    const viewport = this.viewport!;
    viewport.dispatchEvent(new CustomEvent("scrollbar:drag-start", { bubbles: true }));
    const thumb = track.firstElementChild!.getBoundingClientRect();
    const coordinate = axis ? event.clientY : event.clientX;
    if (coordinate < (axis ? thumb.top : thumb.left) || coordinate > (axis ? thumb.bottom : thumb.right)) {
      const bounds = track.getBoundingClientRect();
      setScrollPosition(viewport, axis, (coordinate - (axis ? bounds.top : bounds.left) - (axis ? thumb.height : thumb.width) / 2) * this.ratio(axis));
    }
    this.drag = { axis, pointer: event.pointerId, origin: coordinate, position: scrollGeometry(viewport, axis).position };
    track.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  private ratio(axis: number): number {
    const viewport = this.viewport!, track = this.tracks[axis]!;
    return scrollGeometry(viewport, axis).maximum / ((axis ? track.clientHeight : track.clientWidth) - (axis ? track.firstElementChild!.getBoundingClientRect().height : track.firstElementChild!.getBoundingClientRect().width));
  }
  move(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    const { axis, origin, position } = this.drag;
    const viewport = this.viewport!;
    setScrollPosition(viewport, axis, position + ((axis ? event.clientY : event.clientX) - origin) * this.ratio(axis));
  }
  end(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    this.drag = null;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (!under?.closest(".scrollbar") && !this.viewport?.contains(under)) this.hide();
  }
}
