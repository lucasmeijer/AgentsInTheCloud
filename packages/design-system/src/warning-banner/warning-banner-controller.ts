import { Controller } from "@hotwired/stimulus";

export async function animateWarningChanges(regions: HTMLElement[], render: () => void | Promise<void>): Promise<void> {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    await render();
    return;
  }
  const previous = regions.map(region => ({
    region, height: region.getBoundingClientRect().height, marginBottom: getComputedStyle(region).marginBottom,
  }));
  await render();
  for (const { region, height, marginBottom } of previous) {
    if (!region.isConnected) continue;
    const nextHeight = region.getBoundingClientRect().height;
    const style = getComputedStyle(region);
    const nextMargin = style.marginBottom;
    if (height === nextHeight && marginBottom === nextMargin) continue;
    region.animate([
      { height: `${height}px`, marginBottom, boxSizing: "border-box", overflow: "clip" },
      { height: `${nextHeight}px`, marginBottom: nextMargin, boxSizing: "border-box", overflow: "clip" },
    ], {
      duration: Number.parseFloat(style.getPropertyValue("--motion-enter")),
      easing: style.getPropertyValue("--motion-ease-out").trim(),
    });
  }
}

export class WarningBannersController extends Controller<HTMLElement> {
  connect(): void { document.addEventListener("turbo:before-stream-render", this.beforeRender); }
  disconnect(): void { document.removeEventListener("turbo:before-stream-render", this.beforeRender); }

  private readonly beforeRender = (event: Event): void => {
    // SAFETY: Turbo supplies the stream's resolved targets and awaited render callback.
    const { detail } = event as CustomEvent<{
      newStream: HTMLElement & { targetElements: HTMLElement[] };
      render(stream: HTMLElement): Promise<void>;
    }>;
    const action = detail.newStream.getAttribute("action")!;
    if (!["update", "replace", "remove"].includes(action)) return;
    const regions = [...new Set(detail.newStream.targetElements.flatMap(target =>
      target.matches(".warning-banner") ? [target.parentElement!] :
        target.querySelector(":scope > .warning-banner") ? [action === "update" ? target : target.parentElement!] : [],
    ))];
    if (regions.length === 0) return;
    const render = detail.render;
    detail.render = stream => animateWarningChanges(regions, () => render(stream));
  };
}
