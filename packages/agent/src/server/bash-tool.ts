import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateLine,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { tailTerminalOutput, terminalOutputDisplayBytes } from "@agents-in-the-cloud/observable-terminal/server";
import { Type } from "typebox";

const maxModelLineChars = 500;
/**
 * Room left below the Harness's tool output limits for what follows the output:
 * the truncation notice and the tool's exit status. The Harness keeps the start of
 * longer text, so without it the notice naming the full output would be cut off.
 */
const modelTrailerLines = 4;
const modelTrailerBytes = 1024;

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

function limitModelLines(text: string): LimitedModelLines {
  let linesTruncated = 0;
  const lines = text.split("\n").map((line) => {
    const limited = truncateLine(line, maxModelLineChars);
    if (limited.wasTruncated) linesTruncated += 1;
    return limited.text;
  });
  return { text: lines.join("\n"), linesTruncated };
}

export function formatBashOutput(text: string, ansi: string, fullOutputPath: string) {
  const modelLines = limitModelLines(text);
  const modelLimited = truncateTail(modelLines.text, { maxLines: DEFAULT_MAX_LINES - modelTrailerLines, maxBytes: DEFAULT_MAX_BYTES - modelTrailerBytes });
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

  let displayAnsi = tailTerminalOutput(ansi, terminalOutputDisplayBytes);
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
