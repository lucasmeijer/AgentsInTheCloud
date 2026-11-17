import { stimulusHtml } from "../html.ts";

export function pageBodyStimulusHtml(controllers: readonly (string | undefined)[]): string {
  return stimulusHtml([...controllers, "scrollbars", "content-rows", "warning-banners"], ["pointermove->scrollbars#hover pointerleave->scrollbars#leave wheel->scrollbars#wheel:!passive touchstart->scrollbars#touchStart:passive touchend->scrollbars#touchEnd touchcancel->scrollbars#touchEnd scroll@document->scrollbars#scroll:capture"]);
}
