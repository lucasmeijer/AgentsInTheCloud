import { layoutAfterEvent, softwareKeyboardArranged } from "@agents-in-the-cloud/shared";

/**
 * A changed size is applied only once it has held this long, so a rotation
 * resizes the PTY once (iOS hides the status bar a few hundred ms after rotating).
 */
const settleMs = 1000;

const contextRows = 3;

export interface TerminalFrameOptions {
  stage: HTMLElement;
  host: HTMLElement;
  measure(): { width: number; height: number };
  resized(): void;
}

/**
 * Keeps a terminal's rows and columns fixed while the composer, the key row or
 * the soft keyboard take space: the stage clips it, and a focused terminal is
 * offset to keep its cursor above the keyboard. The PTY is resized only when
 * the space itself changes (rotation, window size), with the keyboard down,
 * once the new size has settled.
 */
export class TerminalFrame {
  private size?: { width: number; height: number };
  private pending?: ReturnType<typeof setTimeout>;
  private readonly cursor = new MutationObserver((records) => {
    if (records.some(({ target }) => target instanceof HTMLTextAreaElement && target.classList.contains("gespenst__input"))) this.frameCursor();
  });

  constructor(private readonly options: TerminalFrameOptions) {
    this.cursor.observe(options.host, { subtree: true, attributes: true, attributeFilter: ["style"] });
    document.addEventListener(layoutAfterEvent, this.layoutChanged);
  }

  dispose(): void {
    clearTimeout(this.pending);
    this.cursor.disconnect();
    document.removeEventListener(layoutAfterEvent, this.layoutChanged);
  }

  private readonly layoutChanged = (): void => {
    this.frameCursor();
    this.update();
  };

  update(): void {
    if (softwareKeyboardArranged()) return;
    const { width, height } = this.options.measure();
    if (width <= 0 || height <= 0) return;
    const size = { width: Math.floor(width), height: Math.floor(height) };
    clearTimeout(this.pending);
    this.pending = undefined;
    if (this.size && this.size.width === size.width && this.size.height === size.height) return;
    if (!this.size) {
      this.apply(size);
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (!softwareKeyboardArranged()) this.apply(size);
    }, settleMs);
  }

  private apply(size: { width: number; height: number }): void {
    this.size = size;
    this.options.host.style.width = `${size.width}px`;
    this.options.host.style.height = `${size.height}px`;
    this.frameCursor();
    this.options.resized();
  }

  frameCursor(): void {
    const { host, stage } = this.options;
    const input = host.querySelector<HTMLTextAreaElement>(".gespenst__input");
    if (!input || document.activeElement !== input || !softwareKeyboardArranged() || !this.size) {
      host.style.removeProperty("top");
      host.style.removeProperty("bottom");
      return;
    }
    const visible = stage.clientHeight;
    const lineHeight = Number.parseFloat(input.style.lineHeight);
    const cursorBottom = Number.parseFloat(input.style.top) + lineHeight;
    const top = Math.max(visible - this.size.height, Math.min(0, Math.round(visible - cursorBottom - contextRows * lineHeight)));
    host.style.top = `${top}px`;
    host.style.bottom = "auto";
  }
}
