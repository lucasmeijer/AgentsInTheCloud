import { changeLayout, type ComposerQuote } from "@agents-in-the-cloud/shared";

export function composerViewportHeight(): number {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return root.clientHeight - Number.parseFloat(style.getPropertyValue("--software-keyboard-inset") || "0")
    - Number.parseFloat(style.getPropertyValue("--software-keyboard-top") || "0");
}

export function sizeComposer(composer: HTMLElement, maxComposer: number): void {
  const input = composer.querySelector<HTMLTextAreaElement>(".composer-input")!;
  if (!composer.checkVisibility()) return;
  const area = input.parentElement!;
  const buttons = area.querySelector<HTMLElement>(":scope > .composer-buttons")!;
  const promptTemplateButtons = area.querySelector<HTMLElement>(":scope > .composer-prompt-template-buttons");
  const height = (element: HTMLElement | null): number => element?.checkVisibility() ? element.getBoundingClientRect().height : 0;
  const chrome = composer.getBoundingClientRect().height - area.getBoundingClientRect().height;
  const current = input.getBoundingClientRect().height;
  const hadText = composer.classList.contains("composer-has-text");
  const hasText = /\S/.test(input.value);
  // Measure without letting the pane reflow: the input area keeps its size,
  // so the transcript above cannot clamp its scroll offset.
  const areaHeight = area.style.height;
  area.style.height = `${area.getBoundingClientRect().height}px`;
  const inline = input.style.height;
  composer.classList.toggle("composer-has-text", hasText);
  input.style.height = "0px";
  const content = Math.ceil(input.scrollHeight);
  const below = height(promptTemplateButtons);
  const beside = getComputedStyle(buttons).position === "absolute" ? 0 : height(buttons);
  const minimum = Math.max(Number.parseFloat(getComputedStyle(input).minHeight) || 0, beside - below);
  const limit = Math.max(minimum, maxComposer - chrome - below);
  composer.classList.toggle("composer-has-text", hadText);
  input.style.height = inline;
  area.style.height = areaHeight;
  const next = Math.max(minimum, Math.min(content, limit));
  const overflow = content > limit ? "auto" : "hidden";
  if (hasText !== hadText || Math.abs(next - current) >= 0.5 || input.style.overflowY !== overflow) {
    changeLayout(() => {
      composer.classList.toggle("composer-has-text", hasText);
      input.style.height = `${next}px`;
      input.style.overflowY = overflow;
    });
  }
  revealComposerCaret(input);
}

export function revealComposerCaret(input: HTMLTextAreaElement): void {
  if (document.activeElement === input && input.selectionEnd === input.value.length) input.scrollTop = input.scrollHeight;
}

export function focusComposerText(composer: HTMLElement, event: MouseEvent): void {
  const input = composer.querySelector<HTMLTextAreaElement>(".composer-input")!;
  const target = event.target instanceof Element ? event.target : null;
  if (input.inert || !target || !composer.contains(target) || target === input) return;
  if (target.closest("button, a, input, select, textarea, label, summary, .agent-chip, .composer-footer, .agent-completion-menu-host")) return;
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

export function formatComposerQuote({ source, text, code }: ComposerQuote): string {
  const body = code ? text.replace(/^(?:[ \t]*\n)+|\s+$/g, "") : text.trim();
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(run => run[0].length + 1)));
  const lines = code ? [fence, ...body.split("\n"), fence] : body.split("\n");
  return [`${source}:`, ...lines].map(line => line.trimEnd() ? `> ${line.trimEnd()}` : ">").join("\n");
}

export function appendComposerQuote(input: HTMLTextAreaElement, quote: ComposerQuote, comment: string): void {
  const draft = input.value;
  const separator = !draft || draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  input.focus({ preventScroll: true });
  input.setSelectionRange(draft.length, draft.length);
  if (!document.execCommand("insertText", false, `${separator}${formatComposerQuote(quote)}\n\n${comment}`)) throw new Error("Could not add the quote to the composer.");
}
