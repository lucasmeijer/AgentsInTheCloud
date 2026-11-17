import { errorMessage } from "@agents-in-the-cloud/shared";
import { parseObservableTerminalMessage, terminalEndedCloseCode, type ObservableTerminalProgressMessage } from "../shared/index.ts";
import { attachObservableTerminal, type ObservableTerminalAttachOptions, type ObservableTerminalConnection } from "./attach.ts";

interface TerminalSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export function terminalSocketDimensions(url: URL) {
  const dimension = (name: string, fallback: number): number => {
    const value = Number(url.searchParams.get(name));
    return Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
  };
  return { cols: dimension("cols", 80), rows: dimension("rows", 24) };
}

export function createObservableTerminalSocket(options: ObservableTerminalAttachOptions, events: {
  ended?: () => Promise<boolean>;
  onProgress?: (progress: ObservableTerminalProgressMessage) => void;
  onClose?: () => void;
} = {}) {
  let terminal: ObservableTerminalConnection | undefined;
  let closed = false;
  const decoder = new TextDecoder();
  return {
    async open(socket: TerminalSocket): Promise<void> {
      try {
        if (events.ended && await events.ended()) {
          if (!closed) socket.close(terminalEndedCloseCode, "ended");
          return;
        }
        if (closed) return;
        terminal = attachObservableTerminal(options, {
          onData: (chunk) => socket.send(chunk),
          onExit: () => {
            if (!events.ended) { socket.close(); return; }
            void events.ended().then((ended) => {
              if (!closed) socket.close(ended ? terminalEndedCloseCode : undefined, ended ? "ended" : undefined);
            // External workspace process failures can reject with arbitrary values.
            // oxlint-disable-next-line anti-slop/no-unknown-parameters
            }).catch((error: unknown) => {
              console.error("Could not check ended terminal session", error);
              if (!closed) socket.close();
            });
          },
        });
      } catch (error) {
        socket.send(`\r\n[terminal attach failed: ${errorMessage(error)}]\r\n`);
        socket.close();
      }
    },
    message(_socket: TerminalSocket, input: string | Uint8Array): void {
      if (options.readonly) return;
      const text = input instanceof Uint8Array ? decoder.decode(input) : input;
      const control = parseObservableTerminalMessage(text);
      if (control?.type === "resize") {
        terminal?.resize(control.cols, control.rows);
      } else if (control?.type === "progress") events.onProgress?.(control);
      else terminal?.write(text);
    },
    close(): void {
      closed = true;
      terminal?.close();
      terminal = undefined;
      events.onClose?.();
    },
  };
}
