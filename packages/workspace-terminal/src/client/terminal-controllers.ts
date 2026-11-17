import {
  agentsInTheCloudObservableTerminalTheme,
  createObservableTerminalViewer,
  observableWebSocketUrl,
  TerminalFrame,
  TerminalTouchFocus,
  createTerminalKeyBarController,
  type ObservableTerminalViewer,
} from "@agents-in-the-cloud/observable-terminal/client";
import { focusLikelyOpensSoftwareKeyboard, isTextEntry, isWorkspacePaneVisible, type WorkspaceClientControllerConstructor, type WorkspaceClientModule } from "@agents-in-the-cloud/shared";

function createTerminalSessionPickerController(Controller: WorkspaceClientControllerConstructor) {
  return class TerminalSessionPickerController extends Controller {
    static targets = ["input", "item"];
    declare readonly inputTarget: HTMLInputElement;
    declare readonly itemTargets: HTMLButtonElement[];

    select(event: Event): void {
      if (!(event.currentTarget instanceof HTMLButtonElement)) throw new Error("terminal session selection must come from a button");
      const session = event.currentTarget.dataset.terminalSession;
      if (!session) throw new Error("terminal session content row is missing its session name");
      this.inputTarget.value = session;
      for (const item of this.itemTargets) item.setAttribute("aria-selected", String(item === event.currentTarget));
    }
  };
}

function createTerminalViewController(Controller: WorkspaceClientControllerConstructor) {
  return class TerminalViewController extends createTerminalKeyBarController(Controller) {
    static values = { url: String };
    static targets = ["connectionStatus", "host", "stage", "ended"];
    declare readonly endedTarget: HTMLElement;
    declare readonly hostTarget: HTMLElement;
    declare readonly stageTarget: HTMLElement;
    declare readonly connectionStatusTarget: HTMLElement;
    declare readonly element: HTMLElement;
    declare readonly urlValue: string;
    private readonly touchFocus = new TerminalTouchFocus(() => this.viewer?.focus());
    private pointerDrag?: { id: number; select: boolean };
    private frame?: TerminalFrame;
    private readonly resize = new ResizeObserver(() => this.frame?.update());

    private viewer?: ObservableTerminalViewer;
    protected get accessoryViewer(): ObservableTerminalViewer | undefined { return this.viewer; }

    start(): void {
      if (!this.frame) {
        const stage = this.stageTarget;
        this.frame = new TerminalFrame({
          stage, host: this.hostTarget,
          measure: () => ({ width: stage.clientWidth, height: stage.clientHeight }),
          resized: () => this.viewer?.refresh(),
        });
        this.resize.observe(stage);
      }
      this.frame.update();
      if (!this.viewer) {
        const style = getComputedStyle(this.hostTarget);
        this.viewer = createObservableTerminalViewer({
          host: this.hostTarget,
          mode: "interactive",
          websocketUrl: observableWebSocketUrl(this.urlValue),
          fontFamily: style.getPropertyValue("--font-mono"),
          fontSize: Number.parseFloat(style.getPropertyValue("--text-code")),
          theme: agentsInTheCloudObservableTerminalTheme(),
          connectionStatus: this.connectionStatusTarget,
          onConnectionStateChange: (state) => {
            this.endedTarget.hidden = state !== "ended";
            this.element.classList.toggle("terminal-is-ended", state === "ended");
            if (state === "ended") {
              this.connectionStatusTarget.hidden = true;
              this.resetAccessoryKeys();
            }
          },
          transformInput: (data) => this.transformAccessoryInput(data),
        });
      } else {
        this.viewer.reconnect();
        this.viewer.refresh();
      }
      if (document.hasFocus() && !focusLikelyOpensSoftwareKeyboard() && !isTextEntry(document.activeElement)) this.viewer.focus();
    }

    stop(): void {
      this.resize.disconnect();
      this.frame?.dispose();
      this.frame = undefined;
      this.viewer?.dispose();
      this.viewer = undefined;
      this.resetAccessoryKeys();
    }

    theme(): void { this.viewer?.setTheme(agentsInTheCloudObservableTerminalTheme()); }

    connect(): void {
      if (isWorkspacePaneVisible(this.element)) {
        this.start();
      }
    }

    disconnect(): void {
      this.touchFocus.cancel();
      this.pointerDrag = undefined;
      this.stop();
    }

    retry(): void { this.viewer?.reconnect(); }

    startTerminalTouch(event: TouchEvent): void { this.touchFocus.start(event); }
    moveTerminalTouch(event: TouchEvent): void { this.touchFocus.move(event); }
    cancelTerminalTouch(): void { this.touchFocus.cancel(); }
    finishTerminalTouch(event: TouchEvent): void { this.touchFocus.finish(event); }

    dragPointer(event: PointerEvent): void {
      if (event.pointerType === "touch") return;
      const host = event.currentTarget;
      if (!(host instanceof HTMLElement)) throw new Error("terminal pointer action must come from its host");
      const viewer = this.viewer;
      if (!viewer) return;
      if (event.type === "pointerdown") {
        if (event.button !== 0 || this.pointerDrag) return;
        this.pointerDrag = { id: event.pointerId, select: !event.shiftKey };
        host.setPointerCapture(event.pointerId);
        viewer.focus();
      }
      const drag = this.pointerDrag;
      if (!drag || drag.id !== event.pointerId) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      const action = event.type === "pointerdown" ? "press"
        : event.type === "pointermove" ? "motion" : "release";
      viewer.dragPointer(event, action, drag.select);
      if (action === "release") {
        this.pointerDrag = undefined;
        if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      }
    }

    allowNativePaste(event: KeyboardEvent): void {
      // Gespenst otherwise encodes Ctrl+V as terminal input and cancels the
      // browser paste event. Keep Ctrl+C untouched for shell interrupts.
      if (event.ctrlKey && !event.altKey && event.code === "KeyV") event.stopImmediatePropagation();
    }
  };
}

export const workspaceTerminalClientModule: WorkspaceClientModule = {
  id: "terminal",
  install({ application, Controller, hooks }) {
    application.register("terminal-view", createTerminalViewController(Controller));
    application.register("terminal-session-picker", createTerminalSessionPickerController(Controller));
    const controller = (pane: HTMLElement) => {
      const element = pane.querySelector<HTMLElement>('[data-controller~="terminal-view"]');
      // SAFETY: This element declares the terminal-view controller registered immediately above.
      return element ? application.getControllerForElementAndIdentifier(element, "terminal-view") as { start(): void; stop(): void } | null : null;
    };
    hooks.onBecomeVisible(({ pane }) => controller(pane)?.start());
    hooks.onNoLongerVisible(({ pane }) => controller(pane)?.stop());
  },
};
