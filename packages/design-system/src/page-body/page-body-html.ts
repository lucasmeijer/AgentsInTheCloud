import { stimulusHtml } from "../html.ts";

/** The page-wide design-system controllers and actions, rendered on `<body>` alongside the page's own controllers. */
export function pageBodyStimulusHtml(controllers: readonly (string | undefined)[]): string {
  return stimulusHtml([...controllers, "scrollbars", "content-rows", "warning-banners"], ["pointermove->scrollbars#hover pointerleave->scrollbars#leave wheel->scrollbars#wheel:!passive"]);
}
