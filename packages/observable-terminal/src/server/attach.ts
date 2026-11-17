import { exitStatus, type StartWorkspaceProcess, type WorkspaceExecStart, type WorkspaceHelperUser } from "@agents-in-the-cloud/workspace-helper";
import { observableTerminalEnvironment } from "./constants.ts";

export interface ObservableTerminalConnection {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface ObservableTerminalEvents {
  onData(data: Uint8Array): void;
  onExit(exitCode: number): void;
}

export interface ObservableTerminalAttachOptions {
  session: string;
  requireExistingServer?: boolean;
  cols: number;
  rows: number;
  readonly?: boolean;
  start: StartWorkspaceProcess;
  user?: WorkspaceHelperUser;
  workdir?: string;
}

function tmuxAttachArgs(options: Omit<ObservableTerminalAttachOptions, "start">): string[] {
  const args: string[] = options.requireExistingServer ? ["-N"] : [];
  if (!options.readonly) {
    // History belongs to tmux, not the browser terminal. Configure each attachment
    // so new and existing sessions work without caller-specific preparation.
    args.push(
      "set-option", "-t", options.session, "mouse", "on", ";",
      "set-option", "-t", options.session, "set-clipboard", "on", ";",
      "bind-key", "-n", "S-PPage", "copy-mode -e ; send-keys -X page-up", ";",
      "bind-key", "-T", "copy-mode", "S-PPage", "send-keys -X page-up", ";",
      "bind-key", "-T", "copy-mode", "S-NPage", "send-keys -X page-down", ";",
    );
  }
  // Tell tmux that the Gespenst client accepts OSC 8. Pi probes this client
  // feature before emitting file:// hyperlinks; RGB alone is not enough.
  if (!options.readonly) {
    args.push("if-shell", "tmux show-options -g terminal-features | grep -Fq 'xterm-256color:hyperlinks'", "", "set-option -gas terminal-features ,xterm-256color:hyperlinks", ";");
    args.push("if-shell", "tmux show-options -g terminal-features | grep -Fq 'xterm-256color:clipboard'", "", "set-option -gas terminal-features ,xterm-256color:clipboard", ";");
  }
  args.push("attach-session");
  if (options.readonly) args.push("-r");
  args.push("-t", options.session);
  return args;
}

export function buildAttachStart(options: Omit<ObservableTerminalAttachOptions, "start">): WorkspaceExecStart {
  return {
    argv: ["tmux", ...tmuxAttachArgs(options)],
    user: options.user ?? "agents-in-the-cloud",
    workdir: options.workdir,
    env: observableTerminalEnvironment,
    terminal: { cols: options.cols, rows: options.rows },
  };
}

export function attachObservableTerminal(options: ObservableTerminalAttachOptions, events: ObservableTerminalEvents): ObservableTerminalConnection {
  // The helper owns the PTY. If AgentsInTheCloud disappears, the call ends and
  // only this tmux client goes with it, never the session.
  const client = options.start(buildAttachStart(options));
  let closed = false;
  const output = (async () => {
    for await (const chunk of client.stdout) events.onData(chunk);
  })();
  void (async () => {
    let exitCode: number;
    try {
      await output;
      exitCode = exitStatus(await client.exited);
    } catch (error) {
      if (!closed) events.onData(new TextEncoder().encode(`\r\n${(error instanceof Error ? error.message : String(error)).replace(/\r?\n/g, "\r\n")}`));
      exitCode = 1;
    }
    closed = true;
    events.onExit(exitCode);
  })();
  return {
    write: (data) => { if (!closed) client.write(data); },
    resize: (cols, rows) => { if (!closed) client.resize({ cols, rows }); },
    close: () => {
      if (closed) return;
      closed = true;
      client.signal("SIGHUP");
    },
  };
}
