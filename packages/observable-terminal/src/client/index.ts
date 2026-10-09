/// <reference lib="dom" />

import type { TerminalBufferRow, TerminalTheme } from "@gespenst/core";
import { copyTextToClipboard, errorMessage } from "@agents-in-the-cloud/shared";
import { encodeObservableTerminalMessage, terminalSessionMissingCloseCode } from "../shared/index.ts";
import { terminalLinkAt, type TerminalLink } from "./links.ts";

declare const ATELIER_GHOSTTY_WASM_URL: string;
declare const ATELIER_GHOSTTY_CALLBACKS_WASM_URL: string;

export type ObservableTerminalTheme = TerminalTheme;

const DEFAULT_OBSERVABLE_TERMINAL_THEME = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  black: "#3b4252",
  brightBlack: "#7b889e",
  brightBlue: "#81a1c1",
  brightWhite: "#eceff4",
} as const satisfies ObservableTerminalTheme;

function cssVariable(name: string): string | undefined {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

function themeColor(name: string, fallbackKey: keyof typeof DEFAULT_OBSERVABLE_TERMINAL_THEME): string {
  return cssVariable(name) ?? DEFAULT_OBSERVABLE_TERMINAL_THEME[fallbackKey];
}

/**
 * Map AgentsInTheCloud's active UI theme onto Gespenst's complete 16-color ANSI palette.
 * Agent themes (Claude, Codex, Pi) draw with these slots, so the roles are a
 * contract: bright white emphasizes, bright black recedes, blue is the accent.
 */
export function agentsInTheCloudObservableTerminalTheme(): ObservableTerminalTheme {
  const background = themeColor("--bg", "background");
  const foreground = themeColor("--text", "foreground");
  const accent = themeColor("--accent", "brightBlue");
  const red = cssVariable("--danger") ?? foreground;
  const green = cssVariable("--success") ?? foreground;
  const amber = cssVariable("--warning") ?? foreground;
  const violet = cssVariable("--decorative") ?? accent;
  return {
    background,
    foreground,
    cursor: accent,
    black: themeColor("--panel", "black"),
    red,
    green,
    yellow: amber,
    blue: accent,
    magenta: violet,
    cyan: accent,
    white: foreground,
    brightBlack: themeColor("--text-muted", "brightBlack"),
    brightRed: red,
    brightGreen: green,
    brightYellow: amber,
    brightBlue: accent,
    brightMagenta: violet,
    brightCyan: accent,
    brightWhite: themeColor("--text-bright", "brightWhite"),
  };
}

// Gespenst focuses on pointerdown, but a native touch release on its canvas can
// undo that focus. Only completed taps should reclaim it; drags must still scroll.
export class TerminalTouchFocus {
  private touch?: Touch;

  constructor(private readonly focus: () => void) {}

  start(event: TouchEvent): void {
    this.touch = event.touches.length === 1 ? event.touches[0] : undefined;
  }

  move(event: TouchEvent): void {
    if (event.touches.length !== 1 || !this.isTap(event.touches[0]!)) this.cancel();
  }

  cancel(): void { this.touch = undefined; }

  finish(event: TouchEvent): void {
    const tapped = event.touches.length === 0 && event.changedTouches.length === 1
      && this.isTap(event.changedTouches[0]!);
    this.cancel();
    if (!tapped) return;
    event.preventDefault();
    this.focus();
  }

  private isTap(touch: Touch): boolean {
    const start = this.touch;
    // Screen coordinates exclude keyboard-induced viewport panning.
    return start !== undefined && touch.identifier === start.identifier
      && Math.hypot(touch.screenX - start.screenX, touch.screenY - start.screenY) <= 10;
  }
}

export interface ObservableTerminalViewer {
  dispose(): void;
  focus(): void;
  refresh(): void;
  /** Reattach after a disconnect; never creates or restarts the session. */
  reconnect(): void;
  sendInput(data: string): void;
  getSelection(): Promise<string>;
  dragPointer(event: PointerEvent, action: "press" | "motion" | "release", select: boolean): void;
  /** Send a touch scroll through the terminal's wheel path, including TUI mouse reporting. */
  scrollTouch(deltaY: number, clientX: number, clientY: number): void;
  /** Resolve a completed touch tap against the painted terminal, before sending TUI input. */
  activateLinkAt(clientX: number, clientY: number): Promise<boolean>;
  /** Hide the input cursor while reading CLI history without changing the PTY. */
  setHistoryCursorHidden(hidden: boolean): void;
  paste(text: string): void;
  pressEnter(): void;
  setTheme(theme: ObservableTerminalTheme): void;
}

type TerminalConnectionState = "connecting" | "connected" | "reconnecting" | "unavailable" | "ended";

/** Update the server-rendered status for any interactive terminal pane. */
function setTerminalConnectionStatus(status: HTMLElement, state: TerminalConnectionState): void {
  status.hidden = state === "connected";
  status.dataset.state = state;
  for (const message of status.querySelectorAll<HTMLElement>("[data-terminal-connection-state]")) {
    message.hidden = message.dataset.terminalConnectionState !== state;
  }
}

interface ObservableTerminalViewerOptions {
  host: HTMLElement;
  websocketUrl: string;
  mode: "interactive" | "fixed-readonly";
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  theme?: ObservableTerminalTheme;
  disconnectedMessage?: string;
  errorMessage?: string;
  transformInput?: (data: string) => string;
  /** Preserve native editing context for CLI prose; shell terminals remain literal. */
  nativeTextInput?: boolean;
  onOutput?: (text: string) => void;
  /** Opt-in file and web link navigation for agent terminals, not arbitrary shell terminals. */
  onLink?: (link: TerminalLink) => void;
  /** Server-rendered status for an interactive terminal. */
  connectionStatus?: HTMLElement;
  /** Hide the cursor while keyboard focus is elsewhere, without changing the PTY. */
  hideUnfocusedCursor?: boolean;
  onConnectionStateChange?: (state: TerminalConnectionState) => void;
}

const terminalProgressState = {
  remove: 0,
  set: 1,
  error: 2,
  indeterminate: 3,
  pause: 4,
} as const;

export function observableWebSocketUrl(path: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}

/** A handle owns initialization too: disposal never waits for WASM or a worker. */
export function createObservableTerminalViewer(options: ObservableTerminalViewerOptions): ObservableTerminalViewer {
  const mount = document.createElement("div");
  mount.className = "observable-terminal-mount";
  options.host.append(mount);
  let viewer: ObservableTerminalViewer | undefined;
  let disposed = false;
  let initializing = false;
  let focusRequested = false;
  let historyCursorHidden = false;
  let theme = options.theme;

  const reportConnection = (state: TerminalConnectionState): void => {
    if (options.connectionStatus) setTerminalConnectionStatus(options.connectionStatus, state);
    options.onConnectionStateChange?.(state);
  };
  const start = (): void => {
    if (disposed || initializing) return;
    if (viewer) { viewer.reconnect(); return; }
    initializing = true;
    reportConnection("connecting");
    mount.textContent = "";
    mount.classList.remove("observable-terminal-painted");
    const initialTheme = theme;
    void initializeTerminalViewer({ ...options, theme: initialTheme, onConnectionStateChange: reportConnection }, mount, () => disposed).then((initialized) => {
      if (disposed) { initialized?.dispose(); return; }
      viewer = initialized!;
      if (historyCursorHidden) viewer.setHistoryCursorHidden(true);
      if (theme && theme !== initialTheme) viewer.setTheme(theme);
      viewer.refresh();
      if (focusRequested && document.hasFocus()) viewer.focus();
    // Browser/worker initialization can reject with arbitrary external values.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the final rendering boundary for browser initialization failures.
    }).catch((error: unknown) => {
      viewer?.dispose();
      viewer = undefined;
      console.error("Terminal initialization failed", error);
      if (!disposed) {
        mount.classList.add("observable-terminal-painted");
        mount.textContent = `[terminal initialization failed: ${errorMessage(error)}]`;
        reportConnection("unavailable");
      }
    }).finally(() => { initializing = false; });
  };
  start();
  return {
    reconnect: start,
    focus: () => { focusRequested = true; viewer?.focus(); },
    refresh: () => viewer?.refresh(),
    sendInput: (data) => viewer?.sendInput(data),
    getSelection: () => viewer?.getSelection() ?? Promise.resolve(""),
    dragPointer: (event, action, select) => viewer?.dragPointer(event, action, select),
    scrollTouch: (deltaY, clientX, clientY) => viewer?.scrollTouch(deltaY, clientX, clientY),
    activateLinkAt: (clientX, clientY) => viewer?.activateLinkAt(clientX, clientY) ?? Promise.resolve(false),
    setHistoryCursorHidden: (hidden) => { historyCursorHidden = hidden; viewer?.setHistoryCursorHidden(hidden); },
    paste: (text) => viewer?.paste(text),
    pressEnter: () => viewer?.pressEnter(),
    setTheme: (value) => { theme = value; viewer?.setTheme(value); },
    dispose: () => { disposed = true; viewer?.dispose(); viewer = undefined; mount.remove(); },
  };
}

async function initializeTerminalViewer(options: ObservableTerminalViewerOptions, mount: HTMLElement, isDisposed: () => boolean): Promise<ObservableTerminalViewer | undefined> {
  let theme = options.theme ?? DEFAULT_OBSERVABLE_TERMINAL_THEME;
  // Validate external configuration before acquiring a terminal/worker.
  const websocketUrl = new URL(options.websocketUrl);
  const fontSize = options.fontSize ?? (options.mode === "fixed-readonly" ? 11 : 13);
  const fontFamily = options.fontFamily ?? "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

  const { createTerminal, KeyModifiers, resolveTerminalTheme } = await import("@gespenst/core");
  if (isDisposed()) return;
  const term = await createTerminal({
    container: mount,
    fontSizePx: fontSize,
    fontFamily,
    scrollbackLines: options.mode === "fixed-readonly" ? 4000 : 10000,
    theme,
    accessibility: "basic",
    worker: "dedicated",
    defaultCursorBlink: options.mode === "interactive",
    wasm: ATELIER_GHOSTTY_WASM_URL,
    callbacksWasm: ATELIER_GHOSTTY_CALLBACKS_WASM_URL,
    cols: options.cols,
    rows: options.rows,
  });
  if (isDisposed()) { term.dispose(); return undefined; }
  try {
    const terminalInput = term.element.querySelector<HTMLTextAreaElement>(".gespenst__input");
    if (terminalInput && options.mode === "fixed-readonly") terminalInput.readOnly = true;
    if (terminalInput && options.mode === "interactive" && options.nativeTextInput) {
      terminalInput.dataset.controller = "native-terminal-text-input";
      terminalInput.dataset.action = "keydown->native-terminal-text-input#keydown:capture input->native-terminal-text-input#input:capture compositionstart->native-terminal-text-input#startComposition:capture compositionend->native-terminal-text-input#finishComposition:capture blur->native-terminal-text-input#reset paste->native-terminal-text-input#reset:capture terminal-text-input:reset->native-terminal-text-input#reset";
    }
    if (options.mode === "fixed-readonly" && options.cols !== undefined && options.rows !== undefined) {
      const devicePixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
      options.host.style.width = `${term.geometry.widthPx / devicePixelRatio}px`;
      options.host.style.height = `${term.geometry.heightPx / devicePixelRatio}px`;
    }

    let ws: WebSocket | undefined;
    const disconnect = (): void => {
      if (!ws) return;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
      ws = undefined;
    };
    const sendInput = (data: string): void => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    };
    // Gespenst is patched to preserve its grid when a hidden host measures 0×0.
    // Only measurable panes can change the PTY size: workspace selection itself
    // must not resize tmux or make TUIs like Pi redraw their whole history.
    let ptySize = { cols: term.geometry.cols, rows: term.geometry.rows };
    // The size the server already has: the attach URL's, or the last one sent.
    let sentSize = ptySize;
    const measurePtySize = (): boolean => {
      const { width, height } = term.element.getBoundingClientRect();
      if (width && height) ptySize = { cols: term.geometry.cols, rows: term.geometry.rows };
      return width > 0 && height > 0;
    };
    // Resizing makes tmux and its TUI redraw everything; only send real changes.
    const sendSize = (): void => {
      if (!measurePtySize() || ws?.readyState !== WebSocket.OPEN) return;
      if (ptySize.cols === sentSize.cols && ptySize.rows === sentSize.rows) return;
      sentSize = ptySize;
      ws.send(encodeObservableTerminalMessage({ type: "resize", ...ptySize }));
    };
    let awaitingFirstOutput = true;
    let disposed = false;
    // Gespenst rejects outstanding worker requests synchronously during dispose,
    // and async continuations can also fail its public ensureActive check. Only
    // these cancellations belong to teardown; other failures must remain visible.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Browser/worker promises may reject with arbitrary values.
    const reportFailure = (operation: string, error: unknown): void => {
      if (disposed && error instanceof Error && (error.message === "Terminal disposed" || error.message === "GespenstTerminal is disposed")) return;
      console.error(`Could not ${operation}`, error);
    };
    let themePending = false;
    let themeDirty = false;
    // Mode 2031 (enabled by tmux) asks for a report whenever the terminal switches between
    // light and dark. tmux then re-queries the colors and notifies panes, so TUIs like Pi
    // can rebuild a theme from the terminal's colors.
    let colorSchemeUpdates = false;
    let appearance = resolveTerminalTheme(theme).appearance;
    const updateTheme = async (): Promise<void> => {
      if (disposed) return;
      themeDirty = true;
      if (themePending) return;
      themePending = true;
      try {
        // Refreshes and theme changes share one queue. Never repaint with
        // term.theme: it remains stale until the worker acknowledges a change.
        while (themeDirty && !disposed) {
          themeDirty = false;
          const next = theme;
          await term.setTheme(next);
          const nextAppearance = resolveTerminalTheme(next).appearance;
          if (nextAppearance === appearance) continue;
          appearance = nextAppearance;
          if (colorSchemeUpdates) sendInput(`\x1b[?997;${appearance === "light" ? 2 : 1}n`);
        }
      } catch (error) {
        reportFailure("update terminal theme", error);
      } finally {
        themePending = false;
      }
    };
    let historyCursorHidden = false;
    let focused = false;
    let cursorHidden = false;
    // The application's own cursor visibility, restored when AgentsInTheCloud stops hiding it.
    let cursorWasVisible: boolean | undefined;
    let cursorVisibilityRevision = 0;
    const hideCursor = (): void => {
      if (cursorHidden && cursorWasVisible !== undefined) term.write("\x1b[?25l");
    };
    const updateCursorVisibility = (): void => {
      const hidden = historyCursorHidden || (options.hideUnfocusedCursor === true && !focused);
      if (cursorHidden === hidden) return;
      cursorHidden = hidden;
      const revision = ++cursorVisibilityRevision;
      if (hidden) {
        cursorWasVisible = undefined;
        void term.readViewport().then(({ cursor }) => {
          if (revision !== cursorVisibilityRevision || cursorWasVisible !== undefined) return;
          cursorWasVisible = cursor.visible;
          hideCursor();
        });
      } else {
        if (cursorWasVisible) term.write("\x1b[?25h");
        cursorWasVisible = undefined;
      }
    };
    if (options.hideUnfocusedCursor) {
      term.element.addEventListener("focusin", () => { focused = true; updateCursorVisibility(); });
      term.element.addEventListener("focusout", () => { focused = false; updateCursorVisibility(); });
      updateCursorVisibility();
    }
    const writeOutput = (data: string | Uint8Array): void => {
      if (disposed) return;
      const text = data instanceof Uint8Array ? latin1.decode(data) : data;
      if (cursorHidden) cursorWasVisible = lastPrivateMode(text, 25) ?? cursorWasVisible;
      colorSchemeUpdates = lastPrivateMode(text, 2031) ?? colorSchemeUpdates;
      if (!awaitingFirstOutput) {
        term.write(data);
        hideCursor();
        return;
      }
      awaitingFirstOutput = false;
      // Keep the pane background visible until the first output has been rendered.
      void term.writeAsync(data).then(() => {
        if (!disposed) { hideCursor(); term.element.classList.add("observable-terminal-painted"); }
      }).catch((error: Error) => {
        reportFailure("paint initial terminal output", error);
      });
    };
    const inputDecoder = new TextDecoder();
    const retryDelays = [100, 250, 500, 1000, 2000, 5000, 5000, 5000];
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempts = 0;
    let ended = false;
    const interactive = options.mode === "interactive";
    let suspended = interactive && document.hidden;
    let hasConnected = false;
    let openedAt = 0;
    const status = (state: TerminalConnectionState): void => options.onConnectionStateChange?.(state);
    const cancelRetry = (): void => { clearTimeout(retryTimer); retryTimer = undefined; };
    const connect = (force = false): void => {
      if (disposed || ended || (interactive && (suspended || document.hidden))) return;
      if (!force && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      cancelRetry();
      disconnect();
      if (interactive) {
        status(hasConnected || retryAttempts > 0 ? "reconnecting" : "connecting");
        measurePtySize();
        sentSize = ptySize;
        websocketUrl.searchParams.set("cols", String(ptySize.cols));
        websocketUrl.searchParams.set("rows", String(ptySize.rows));
      }
      openedAt = 0;
      const socket = ws = new WebSocket(websocketUrl);
      socket.binaryType = "arraybuffer";
      const outputDecoder = new TextDecoder();
      socket.onopen = () => {
        openedAt = Date.now();
        hasConnected = true;
        if (interactive) sendSize();
        status("connected");
      };
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
        options.onOutput?.(data instanceof Uint8Array ? outputDecoder.decode(data, { stream: true }) : data);
        writeOutput(data);
      };
      socket.onclose = (event) => {
        if (ws !== socket || disposed) return;
        ws = undefined;
        if (event.code === terminalSessionMissingCloseCode) {
          ended = true;
          cancelRetry();
          if (terminalInput) { terminalInput.readOnly = true; terminalInput.blur(); }
          historyCursorHidden = true;
          updateCursorVisibility();
          status("ended");
          return;
        }
        if (interactive) {
          if (suspended || document.hidden) return;
          // A failed attach can open and immediately close; do not count it as recovery.
          if (openedAt && Date.now() - openedAt >= 10_000) retryAttempts = 0;
          if (retryAttempts >= retryDelays.length) { status("unavailable"); return; }
          status("reconnecting");
          const delay = retryDelays[retryAttempts++]!;
          retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, delay);
        } else {
          if (options.disconnectedMessage) writeOutput(options.disconnectedMessage);
          status("unavailable");
        }
      };
      socket.onerror = () => {
        if (!interactive && options.errorMessage) writeOutput(options.errorMessage);
      };
    };
    const suspend = (): void => {
      if (!interactive || disposed || ended) return;
      suspended = true;
      cancelRetry();
      disconnect();
      status("reconnecting");
    };
    const resume = (): void => {
      if (!interactive || disposed || document.hidden || !suspended) return;
      suspended = false;
      retryAttempts = 0;
      connect(true);
    };
    const visibilityChanged = (): void => { if (document.hidden) suspend(); else resume(); };
    const networkRestored = (): void => {
      if (!interactive || disposed || document.hidden || suspended) return;
      retryAttempts = 0;
      connect(true);
    };
    if (interactive) {
      document.addEventListener("visibilitychange", visibilityChanged);
      window.addEventListener("pagehide", suspend);
      window.addEventListener("pageshow", resume);
      window.addEventListener("online", networkRestored);
    }
    term.on("error", (error) => console.error("Gespenst terminal error", error));
    if (options.mode === "interactive") {
      term.on("clipboardWrite", ({ location, contents }) => {
        if (location !== "standard") return;
        const text = contents.find((content) => content.mime === "text/plain");
        if (!text) return;
        // Browser clipboard promises may reject with arbitrary platform errors.
        // oxlint-disable-next-line anti-slop/no-unknown-parameters
        void copyTextToClipboard(new TextDecoder().decode(text.data)).catch((error: unknown) => console.error("Could not copy terminal output to clipboard", error));
      });
    }
    // Shift+drag forces a selection over a mouse-tracking TUI, but a plain click
    // is then encoded as application input and never reaches Gespenst's
    // selection gesture, so nothing would ever clear the highlight.
    term.element.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && !event.shiftKey) term.clearSelection();
    }, { capture: true });

    // Gespenst renders into a canvas, so there are no anchors to click. Read
    // its authoritative cells instead of parsing the PTY byte stream. Only buffer
    // rows carry OSC 8 destinations; viewport snapshots omit them. Without a
    // range, readBuffer returns the visible viewport.
    const linkAtPoint = (rows: readonly TerminalBufferRow[], clientX: number, clientY: number, bounds = term.element.getBoundingClientRect()) => {
      const scale = Math.max(1, globalThis.devicePixelRatio || 1);
      const column = Math.floor((clientX - bounds.left) * scale / term.geometry.cellWidthPx);
      const row = Math.floor((clientY - bounds.top) * scale / term.geometry.cellHeightPx);
      return rows[row] && column >= 0 && column < term.geometry.cols ? terminalLinkAt(rows[row], column) : undefined;
    };
    if (options.onLink) {
      let rows: readonly TerminalBufferRow[] = [];
      let pointerInside = false;
      let hoverEvent: PointerEvent | undefined;
      let pointerStart: { id: number; x: number; y: number } | undefined;
      const linkAt = (event: PointerEvent) => linkAtPoint(rows, event.clientX, event.clientY);
      let reading = false;
      let dirty = false;
      const updateRows = async () => {
        dirty = true;
        if (reading) return;
        reading = true;
        try {
          while (dirty && !disposed) {
            dirty = false;
            rows = (await term.readBuffer()).rows;
            term.element.style.cursor = hoverEvent && linkAt(hoverEvent) ? "pointer" : "";
          }
        } finally { reading = false; }
      };
      term.on("viewportChange", () => { if (pointerInside) void updateRows(); });
      term.element.addEventListener("pointerenter", () => { pointerInside = true; void updateRows(); });
      term.element.addEventListener("pointermove", (event) => {
        hoverEvent = event;
        term.element.style.cursor = linkAt(event) ? "pointer" : "";
      });
      term.element.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "touch") return;
        pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
        // Do not send mouse input to a TUI when tapping a known link.
        if (linkAt(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, { capture: true });
      term.element.addEventListener("pointerup", (event) => {
        if (event.pointerType === "touch") return;
        const start = pointerStart;
        pointerStart = undefined;
        if (!start || start.id !== event.pointerId || Math.hypot(start.x - event.clientX, start.y - event.clientY) > 10) return;
        const link = linkAt(event);
        if (link) {
          event.preventDefault();
          event.stopImmediatePropagation();
          options.onLink!(link);
        } else {
          // A first touch can arrive before the viewport read completes.
          void updateRows().then(() => { if (!disposed) { const target = linkAt(event); if (target) options.onLink!(target); } });
        }
      }, { capture: true });
      term.element.addEventListener("pointerleave", () => { pointerInside = false; hoverEvent = undefined; term.element.style.cursor = ""; pointerStart = undefined; });
    }

    if (options.mode === "interactive") {
      term.on("progress", ({ state, progress }) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(encodeObservableTerminalMessage({ type: "progress", state: terminalProgressState[state], value: progress ?? undefined }));
        }
      });
      term.on("resize", sendSize);
      term.on("input", ({ data }) => {
        const text = inputDecoder.decode(data, { stream: true });
        sendInput(options.transformInput?.(text) ?? text);
      });
    }

    connect();
    return {
      reconnect: () => { retryAttempts = 0; connect(true); },
      focus: () => { if (!ended) term.focus(); },
      refresh: () => {
        term.fit();
        if (options.mode === "interactive") sendSize();
        // Gespenst has no explicit repaint operation. Reapplying the active theme
        // invalidates every row and repaints from its authoritative buffer.
        void updateTheme();
      },
      sendInput,
      getSelection: () => term.getSelection(),
      dragPointer: (event, action, select) => {
        const bounds = term.element.getBoundingClientRect();
        const scale = Math.max(1, globalThis.devicePixelRatio || 1);
        term.sendPointer({
          action,
          button: "left",
          x: (event.clientX - bounds.left) * scale,
          y: (event.clientY - bounds.top) * scale,
          anyButtonPressed: action !== "release",
          forceSelection: select,
          rectangle: event.altKey,
          // Shift chooses application mouse input, not an application modifier.
          modifiers: (event.ctrlKey ? KeyModifiers.control : 0)
            | (event.altKey ? KeyModifiers.alt : 0)
            | (event.metaKey ? KeyModifiers.meta : 0),
          timeMs: event.timeStamp,
        });
      },
      scrollTouch: (deltaY, clientX, clientY) => {
        term.element.dispatchEvent(new WheelEvent("wheel", { deltaY, clientX, clientY, cancelable: true }));
      },
      activateLinkAt: async (clientX, clientY) => {
        if (!options.onLink || disposed) return false;
        // A tap can focus the terminal and shift it above the software keyboard
        // while the viewport read is pending. Resolve the tapped cell against
        // its position at the time of the tap, not its new position.
        const bounds = term.element.getBoundingClientRect();
        const link = linkAtPoint((await term.readBuffer()).rows, clientX, clientY, bounds);
        if (!link || disposed) return false;
        options.onLink(link);
        return true;
      },
      setHistoryCursorHidden: (hidden) => { historyCursorHidden = hidden; updateCursorVisibility(); },
      paste: (text) => term.paste(text),
      pressEnter: () => term.sendKey({ code: "Enter", text: "\r" }),
      setTheme: (nextTheme) => { theme = nextTheme; void updateTheme(); },
      dispose: () => {
        disposed = true;
        cancelRetry();
        if (interactive) {
          document.removeEventListener("visibilitychange", visibilityChanged);
          window.removeEventListener("pagehide", suspend);
          window.removeEventListener("pageshow", resume);
          window.removeEventListener("online", networkRestored);
        }
        disconnect();
        term.dispose();
      },
    };
  } catch (error) {
    term.dispose();
    throw error;
  }
}

const latin1 = new TextDecoder("latin1");
/** The final state an output chunk sets a DEC private mode to, such as DECTCEM (25), if any. */
function lastPrivateMode(text: string, mode: number): boolean | undefined {
  const set = text.lastIndexOf(`\x1b[?${mode}h`);
  const reset = text.lastIndexOf(`\x1b[?${mode}l`);
  if (set === reset) return undefined;
  return set > reset;
}

export { createTerminalKeyBarController } from "./key-bar.ts";
export { TerminalFrame } from "./terminal-frame.ts";

export { createNativeTerminalTextInputController } from "./native-text-input.ts";
