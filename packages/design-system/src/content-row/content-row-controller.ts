import { Controller } from "@hotwired/stimulus";

const contentRowSelector = ".content-row--compact";
const labelSelector = ".content-row__label";
const labelTextSelector = ".content-row__label-text";
const scrollingClass = "is-label-scrolling";

export class ContentRowController extends Controller<HTMLElement> {
  connect(): void {
    this.element.addEventListener("mouseover", this.startLabelScroll);
    this.element.addEventListener("mouseout", this.stopPointerLabelScroll);
    this.element.addEventListener("focusin", this.startLabelScroll);
    this.element.addEventListener("focusout", this.stopFocusLabelScroll);
    this.element.addEventListener("turbo:before-morph-element", this.preserveBrowserState);
  }

  disconnect(): void {
    this.element.removeEventListener("mouseover", this.startLabelScroll);
    this.element.removeEventListener("mouseout", this.stopPointerLabelScroll);
    this.element.removeEventListener("focusin", this.startLabelScroll);
    this.element.removeEventListener("focusout", this.stopFocusLabelScroll);
    this.element.removeEventListener("turbo:before-morph-element", this.preserveBrowserState);
  }

  private readonly preserveBrowserState = (event: Event): void => {
    const item = event.target;
    if (!(item instanceof HTMLElement) || !item.matches(contentRowSelector)) return;
    // SAFETY: Turbo's before-morph-element event supplies newElement except for removals.
    const { newElement } = (event as CustomEvent<{ newElement?: Element }>).detail;
    if (!(newElement instanceof HTMLElement) || !newElement.matches(contentRowSelector)) return;
    const actionsWidth = item.style.getPropertyValue("--content-row-actions-width");
    if (actionsWidth) newElement.style.setProperty("--content-row-actions-width", actionsWidth);
    if (!item.classList.contains(scrollingClass)) return;
    // Merge only browser-owned animation state into the incoming markup. Keeping
    // the animation applied continuously preserves its progress, while allowing
    // server-owned classes, styles, and contents to morph normally.
    newElement.classList.add(scrollingClass);
    for (const property of ["--content-row-label-scroll-distance", "--content-row-label-scroll-duration"]) {
      newElement.style.setProperty(property, item.style.getPropertyValue(property));
    }
  };

  private transitionedItem(event: MouseEvent | FocusEvent): HTMLElement | null {
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>(contentRowSelector) : null;
    return item && !(event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) ? item : null;
  }

  private readonly startLabelScroll = (event: MouseEvent | FocusEvent): void => {
    const item = this.transitionedItem(event);
    if (!item) return;
    const viewport = item.querySelector<HTMLElement>(labelSelector);
    const text = viewport?.querySelector<HTMLElement>(`:scope > ${labelTextSelector}`);
    if (!viewport || !text) return;
    const distance = text.scrollWidth - viewport.clientWidth;
    if (distance <= 0) return;
    item.style.setProperty("--content-row-label-scroll-distance", `${distance}px`);
    item.style.setProperty("--content-row-label-scroll-duration", `${Math.max(2.5, distance / 64 + 0.8)}s`);
    item.classList.add(scrollingClass);
  };

  private readonly stopPointerLabelScroll = (event: MouseEvent): void => {
    this.transitionedItem(event)?.classList.remove(scrollingClass);
  };

  private readonly stopFocusLabelScroll = (event: FocusEvent): void => {
    const item = this.transitionedItem(event);
    if (item && !item.matches(":hover")) item.classList.remove(scrollingClass);
  };
}

export function setContentRowLabel(element: HTMLElement, text: string): void {
  element.querySelector<HTMLElement>(labelTextSelector)!.textContent = text;
}
