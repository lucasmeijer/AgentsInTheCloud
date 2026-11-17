export type PageSlideDirection = "forward" | "back";

let activeTransition: ViewTransition | undefined;

/**
 * Snapshot only the changing body; chrome updates in place. The render callback must
 * return the incoming body (which may be the same element). No copied DOM, duplicate
 * forms/controllers, or retained credentials are needed for an outgoing page.
 */
export async function slidePageChange(
  currentBody: () => HTMLElement,
  render: () => HTMLElement | Promise<HTMLElement>,
  direction: PageSlideDirection,
): Promise<void> {
  while (activeTransition) {
    activeTransition.skipTransition();
    await activeTransition.finished;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !document.startViewTransition) {
    await render();
    return;
  }

  const outgoing = currentBody();
  const outgoingName = outgoing.style.viewTransitionName;
  const rtl = getComputedStyle(outgoing).direction === "rtl";
  document.documentElement.dataset.pageSlide = (direction === "forward") !== rtl ? "left" : "right";
  outgoing.style.viewTransitionName = "page-slide";
  let incoming: HTMLElement | undefined;
  let incomingName = "";
  const transition = document.startViewTransition(async () => {
    incoming = await render();
    outgoing.style.viewTransitionName = outgoingName;
    incomingName = incoming.style.viewTransitionName;
    incoming.style.viewTransitionName = "page-slide";
  });
  activeTransition = transition;
  try {
    await transition.finished;
  } finally {
    outgoing.style.viewTransitionName = outgoingName;
    if (incoming) incoming.style.viewTransitionName = incomingName;
    delete document.documentElement.dataset.pageSlide;
    activeTransition = undefined;
  }
}
