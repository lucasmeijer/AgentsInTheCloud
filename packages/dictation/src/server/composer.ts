import { progressButtonHtml } from "@agents-in-the-cloud/design-system/progress-button";

export const dictationComposerController = "dictation-composer";

const microphoneIcon = `<svg class="dictation-microphone" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 12.5a3 3 0 0 0 3-3v-4a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3Zm-5-3a5 5 0 0 0 10 0M10 14.5V18m-3 0h6"/></svg>`;

export function renderDictationComposerControl(): string {
  const button = progressButtonHtml({
    type: "button",
    variant: "secondary",
    iconOnly: true,
    initialLabel: "Dictate with microphone",
    progressLabel: "Preparing microphone",
    state: "initial",
    initialContent: { kind: "html", html: `${microphoneIcon}<canvas data-dictation-composer-target="waveform" aria-hidden="true"></canvas>` },
    progressContent: { kind: "html", html: '<i class="activity-spinner" aria-hidden="true"></i>' },
    attributesHtml: 'data-popular-button aria-pressed="false" data-state="idle" data-dictation-composer-target="button"',
    actions: "dictation-composer#toggle",
  });
  return `${button}<span class="dictation-status" data-dictation-composer-target="status" aria-live="polite">Dictate</span>`;
}
