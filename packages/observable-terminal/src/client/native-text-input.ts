import { type WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";

export function createNativeTerminalTextInputController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    declare readonly element: HTMLTextAreaElement;
    private previous = "";
    private composing = false;
    private readonly graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    private get nativeEditing(): boolean { return document.documentElement.classList.contains("software-keyboard-visible"); }

    connect(): void {
      this.element.autocapitalize = "sentences";
      this.element.setAttribute("autocorrect", "on");
      this.element.spellcheck = true;
    }

    reset(): void {
      this.previous = "";
      this.element.value = "";
    }

    keydown(event: KeyboardEvent): void {
      if (this.nativeEditing && !event.ctrlKey && !event.altKey && !event.metaKey
        && (event.key.length === 1 || event.key === "Backspace" || event.key === "Unidentified")) {
        event.stopImmediatePropagation();
        return;
      }
      this.reset();
    }

    input(event: InputEvent): void {
      if (!this.nativeEditing) return;
      event.stopImmediatePropagation();
      if (!this.composing && !event.isComposing) this.sendEdit();
    }

    startComposition(event: CompositionEvent): void {
      if (!this.nativeEditing) return;
      event.stopImmediatePropagation();
      this.composing = true;
    }

    finishComposition(event: CompositionEvent): void {
      if (!this.nativeEditing) return;
      event.stopImmediatePropagation();
      this.composing = false;
      this.sendEdit();
    }

    private sendEdit(): void {
      const next = this.element.value.replaceAll("\u00a0", " ");
      const previous = Array.from(this.graphemes.segment(this.previous), ({ segment }) => segment);
      const current = Array.from(this.graphemes.segment(next), ({ segment }) => segment);
      let prefix = 0;
      while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix++;
      const data = "\x7f".repeat(previous.length - prefix) + current.slice(prefix).join("").replace(/\r\n|\r|\n/g, "\r");
      this.previous = next;
      if (data) this.element.dispatchEvent(new CustomEvent("terminal-text-input:input", { bubbles: true, detail: { data } }));
    }
  };
}
