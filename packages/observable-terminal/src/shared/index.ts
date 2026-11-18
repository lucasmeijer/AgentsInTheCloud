import { isJsonObject } from "@agents-in-the-cloud/core/json-request";

interface ObservableTerminalResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

export interface ObservableTerminalProgressMessage {
  type: "progress";
  state: number;
  value?: number;
}

type ObservableTerminalControlMessage = ObservableTerminalResizeMessage | ObservableTerminalProgressMessage;

export function encodeObservableTerminalMessage(message: ObservableTerminalControlMessage): string {
  return JSON.stringify(message);
}

export function parseObservableTerminalMessage(text: string): ObservableTerminalControlMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  if (parsed.type === "resize") {
    const cols = Number(parsed.cols);
    const rows = Number(parsed.rows);
    return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 ? { type: "resize", cols, rows } : undefined;
  }
  if (parsed.type === "progress") {
    const state = Number(parsed.state);
    const value = parsed.value === undefined ? undefined : Number(parsed.value);
    return Number.isInteger(state) && state >= 0 && state <= 4 && (value === undefined || Number.isFinite(value)) ? { type: "progress", state, value } : undefined;
  }
  return undefined;
}

export function terminalProcessSocketPath(workspaceId: string, id: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/terminal-processes/${encodeURIComponent(id)}/ws`;
}

export function appTerminalProcessSocketPath(id: string): string {
  return `/terminal-processes/${encodeURIComponent(id)}/ws`;
}

export const terminalEndedCloseCode = 4404;
