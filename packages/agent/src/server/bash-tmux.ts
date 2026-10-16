import type { WorkspaceServerSocketSession } from "@agents-in-the-cloud/shared";
import { startInWorkspace } from "@agents-in-the-cloud/workspace";
import {
  createObservableTerminalSocket,
  normalizeCarriageReturns,
  observableTerminalCols,
  observableTerminalRows,
  stripObservablePaneFraming,
  stripTerminalControls,
} from "@agents-in-the-cloud/observable-terminal/server";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateLine,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const maxModelLineChars = 500;
const maxDisplayAnsiBytes = 200_000;

/**
 * Color conventions understood by the most common build-tool ecosystems.
 *
 * TERM/COLORTERM advertise terminal capabilities. CLICOLOR is the general
 * opt-in convention and CLICOLOR_FORCE makes it unconditional. FORCE_COLOR is
 * the equivalent convention used broadly by JavaScript and Rust CLIs. The
 * remaining variables cover CMake/Make, Cargo/Rust loggers, Python tools, and
 * .NET respectively.
 */
export const forcedColorEnvironment = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  CLICOLOR: 1,
  CLICOLOR_FORCE: 1,
  FORCE_COLOR: 1,
  COLOR: 1,
  CMAKE_COLOR_DIAGNOSTICS: "ON",
  CARGO_TERM_COLOR: "always",
  RUST_LOG_STYLE: "always",
  PY_COLORS: 1,
  DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION: 1,
} as const;

interface LimitedModelLines {
  text: string;
  linesTruncated: number;
}

function plainModelOutput(text: string): string {
  return stripTerminalControls(text).trimEnd();
}

function limitModelLines(text: string): LimitedModelLines {
  let linesTruncated = 0;
  const lines = text.split("\n").map((line) => {
    const limited = truncateLine(line, maxModelLineChars);
    if (limited.wasTruncated) linesTruncated += 1;
    return limited.text;
  });
  return { text: lines.join("\n"), linesTruncated };
}

export function formatBashOutput(modelPane: string, displayPane: string, fullOutputPath: string) {
  const modelLines = limitModelLines(plainModelOutput(stripObservablePaneFraming(modelPane)));
  const modelLimited = truncateTail(modelLines.text);
  let output = modelLimited.content;
  const modelTruncated = modelLimited.truncated || modelLines.linesTruncated > 0;
  let truncationNotice = "";
  if (modelTruncated) {
    const reasons = [];
    if (modelLimited.truncated) reasons.push(`showing the last ${formatSize(modelLimited.outputBytes)} of output`);
    if (modelLines.linesTruncated > 0) reasons.push(`${modelLines.linesTruncated} line${modelLines.linesTruncated === 1 ? "" : "s"} shortened to ${maxModelLineChars} characters`);
    truncationNotice = `[Output truncated: ${reasons.join("; ")}. Full output: ${fullOutputPath}]`;
    output += `\n\n${truncationNotice}`;
  }

  const displayLimited = truncateTail(stripObservablePaneFraming(displayPane), { maxBytes: maxDisplayAnsiBytes, maxLines: Number.MAX_SAFE_INTEGER });
  let displayAnsi = normalizeCarriageReturns(displayLimited.content).trimEnd();
  if (displayLimited.truncated) displayAnsi = `… output truncated to last ${maxDisplayAnsiBytes} bytes\n${displayAnsi}`;
  if (truncationNotice) displayAnsi += `\n\n${truncationNotice}`;

  return { output, displayAnsi, modelTruncated };
}

export const bashToolDefinition = {
  name: "bash",
  label: "Bash",
  description: `the bash toolcall will be executed inside of a tmux session for visibility. the visualizer supports ANSI colors; use them whenever possible, but colors are stripped before output is returned to the model. output shown to the model is limited to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, and individual lines are shortened to ${maxModelLineChars} characters; truncated full output is saved to a temporary file. avoid redirecting output to nowhere. avoid the programs you're invoking from attempting to read from stdin, as that will hang the toolcall.`,
  parameters: Type.Object({
    command: Type.String({ description: "The bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 600)" })),
  }),
};

// ---------------------------------------------------------------------------
// Inline terminal websocket: read-only attach to an agent tmux session.
// ---------------------------------------------------------------------------

export function createAgentTermSocketSession(url: URL): WorkspaceServerSocketSession | undefined {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agent-term\/([^/]+)\/ws$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1]);
  const session = decodeURIComponent(match[2]);
  if (!/^agents-in-the-cloud-agent-(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(session)) return undefined;
  return createObservableTerminalSocket({
    start: (start) => startInWorkspace(workspaceId, start),
    session,
    // The receipt supervisor uses the default workspace server.
    requireExistingServer: true,
    // Inline terminals must never resize the agent's fixed-size command pane.
    cols: observableTerminalCols,
    rows: observableTerminalRows,
    user: "agents-in-the-cloud",
    readonly: true,
    fixedSize: true,
  });
}
