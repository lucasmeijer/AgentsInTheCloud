import type { WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";
import type { ObservableTerminalViewer } from "./index.ts";

const terminalAccessoryInput = new Map([
  ["escape", "\x1b"],
  ["tab", "\t"],
  ["up", "\x1b[A"],
  ["down", "\x1b[B"],
  ["right", "\x1b[C"],
  ["left", "\x1b[D"],
]);

export function terminalInputForAccessoryKey(key: string): string {
  const input = terminalAccessoryInput.get(key);
  if (input === undefined) throw new Error(`unknown terminal accessory key: ${key}`);
  return input;
}

export function controlModifiedTerminalInput(data: string): string {
  if (/^\x1b(?:\[|O)[ABCD]$/.test(data)) return `\x1b[1;5${data.at(-1)}`;
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (data === "?") return "\x7f";
  if (data === " ") return "\x00";
  return data;
}

const controlDoubleTapMs = 400;

export function createTerminalKeyBarController(Controller: WorkspaceClientControllerConstructor) {
  abstract class TerminalKeyBarController extends Controller {
    static targets = ["control"];
    declare readonly controlTarget: HTMLButtonElement;
    protected abstract readonly accessoryViewer: ObservableTerminalViewer | undefined;
    private control: "off" | "next" | "locked" = "off";
    private controlTappedAt = 0;

    protected transformAccessoryInput(data: string): string {
      if (this.control === "off") return data;
      if (this.control === "next") this.setControl("off");
      return controlModifiedTerminalInput(data);
    }

    protected resetAccessoryKeys(): void { this.setControl("off"); }

    private setControl(control: "off" | "next" | "locked"): void {
      this.control = control;
      this.controlTarget.setAttribute("aria-pressed", String(control !== "off"));
      this.controlTarget.setAttribute("aria-label", control === "locked" ? "Control, locked on" : "Control for next keystroke");
    }

    private tapControl(now: number): void {
      const doubleTap = now - this.controlTappedAt <= controlDoubleTapMs;
      this.controlTappedAt = now;
      if (this.control === "off") this.setControl("next");
      else if (this.control === "next" && doubleTap) this.setControl("locked");
      else this.setControl("off");
    }

    preserveTerminalFocus(event: MouseEvent): void {
      if (event.button === 0) event.preventDefault();
    }

    sendAccessoryKey(event: Event): void {
      if (!(event.currentTarget instanceof HTMLButtonElement)) throw new Error("terminal key action must come from a button");
      const key = event.currentTarget.dataset.terminalKey;
      if (!key) throw new Error("terminal key button is missing its key");
      this.element.querySelector(".gespenst__input")?.dispatchEvent(new Event("terminal-text-input:reset"));
      const viewer = this.accessoryViewer;
      if (key === "control") this.tapControl(event.timeStamp);
      else viewer?.sendInput(this.transformAccessoryInput(terminalInputForAccessoryKey(key)));
      viewer?.setHistoryCursorHidden(false);
      viewer?.focus();
    }
  }
  return TerminalKeyBarController;
}
