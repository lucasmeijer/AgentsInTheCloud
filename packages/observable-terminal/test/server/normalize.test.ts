import { describe, expect, test } from "bun:test";
import { buildListSessionsCommand, buildObservableSessionCommand, normalizeCarriageReturns, observableTerminalCols, observableTerminalRows, stripObservablePaneFraming, stripTerminalControls } from "../../src/server/index.ts";
import { buildAttachStart } from "../../src/server/attach.ts";

describe("observable terminal normalization", () => {
  test("collapses carriage-return progress repaints", () => {
    const raw = "Cloning into 'repo'...\r\nremote: Counting objects:   1% (1/94)\rremote: Counting objects:   2% (2/94)\rremote: Counting objects: 100% (94/94)\r\n";
    const normalized = normalizeCarriageReturns(raw);
    expect(normalized).toBe("Cloning into 'repo'...\nremote: Counting objects: 100% (94/94)\n");
    expect(normalized).not.toContain("1% (1/94)remote:");
  });

  test("removes full and partial dead-pane markers", () => {
    expect(stripObservablePaneFraming("ok\nPane is dead\n")).toBe("ok");
    expect(stripObservablePaneFraming("ok\n\u001b[2mPane is dead\u001b[0m\r\n")).toBe("ok");
    expect(stripObservablePaneFraming("ok\nPane is dea")).toBe("ok");
  });

  test("strips terminal control sequences without leaking their final bytes", () => {
    expect(stripTerminalControls("\u001b[?1h\u001b=ok\u001b>")).toBe("ok");
    expect(stripTerminalControls("a\u001b[2Kb\u001b[39;49mc")).toBe("abc");
    expect(stripTerminalControls("a\u001b]8;;file:///tmp/x\u001b\\b\u001b]8;;\u001b\\c")).toBe("abc");
    expect(stripTerminalControls("a\u001bPignored\u001b\\b")).toBe("ab");
  });

  test("quotes custom tmux session list formats", () => {
    expect(buildListSessionsCommand("#{session_name} | #{pane_current_path}")).toBe("tmux list-sessions -F '#{session_name} | #{pane_current_path}'");
  });

  test("interactive attachments configure tmux-owned scrollback before attaching", () => {
    const start = buildAttachStart({ session: "s", cols: 80, rows: 24, socketName: "isolated" });
    expect(start.argv).toEqual([
      "tmux", "-L", "isolated",
      "set-option", "-t", "s", "mouse", "on", ";",
      "set-option", "-t", "s", "set-clipboard", "on", ";",
      "bind-key", "-n", "S-PPage", "copy-mode -e ; send-keys -X page-up", ";",
      "bind-key", "-T", "copy-mode", "S-PPage", "send-keys -X page-up", ";",
      "bind-key", "-T", "copy-mode", "S-NPage", "send-keys -X page-down", ";",
      "if-shell", "tmux -L 'isolated' show-options -g terminal-features | grep -Fq 'xterm-256color:hyperlinks'", "", "set-option -gas terminal-features ,xterm-256color:hyperlinks", ";",
      "if-shell", "tmux -L 'isolated' show-options -g terminal-features | grep -Fq 'xterm-256color:clipboard'", "", "set-option -gas terminal-features ,xterm-256color:clipboard", ";",
      "attach-session", "-t", "s",
    ]);
  });

  test("read-only attachments do not configure scrollback", () => {
    const start = buildAttachStart({ session: "s", cols: 80, rows: 24, readonly: true });
    expect(start.argv).toEqual(["tmux", "attach-session", "-r", "-t", "s"]);
  });

  test("builds fixed-size observable sessions", () => {
    const command = buildObservableSessionCommand({ session: "s", cwd: "/work", command: "/bin/bash", fixedSize: true });
    expect(command).not.toContain("set-option -g");
    expect(command).toContain(`-x ${observableTerminalCols} -y ${observableTerminalRows}`);
    expect(command).toContain("window-size manual");
    expect(command).toContain(`resize-window -t 's' -x ${observableTerminalCols} -y ${observableTerminalRows}`);
    expect(command).toContain("status off");
  });

  test("hides tmux dead-pane footer when panes remain on exit", () => {
    const command = buildObservableSessionCommand({ session: "s", cwd: "/work", command: "/bin/bash", remainOnExit: true });
    expect(command).toContain("remain-on-exit on");
    expect(command).toContain("remain-on-exit-format ''");
  });

  test("builds readonly fixed-size attach arguments", () => {
    const start = buildAttachStart({ session: "s", cols: 120, rows: 30, readonly: true, fixedSize: true });
    expect(start.argv).toContain("resize-window");
    expect(start.argv).toContain("attach-session");
    expect(start.argv).toContain("-r");
    expect(start.terminal).toEqual({ cols: 120, rows: 30 });
    expect(start.stdin).toBeUndefined();
  });
});

test("receipt UUID sessions attach read-only to an existing server using a window target", async () => {
  const socketName = `agents-in-the-cloud-attach-${crypto.randomUUID()}`;
  const session = `agents-in-the-cloud-agent-${crypto.randomUUID()}`;
  const run = async (args: string[]) => {
    const process = Bun.spawn(["tmux", "-L", socketName, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: await process.exited, output: await new Response(process.stdout).text(), error: await new Response(process.stderr).text() };
  };
  expect((await run(["new-session", "-d", "-s", session, "sleep 30"])).code).toBe(0);
  try {
    const bridge = { args: buildAttachStart({ session, cols: 120, rows: 30, readonly: true, fixedSize: true, requireExistingServer: true }).argv.slice(1) };
    expect(bridge.args[0]).toBe("-N");
    expect(bridge.args).not.toContain("-L");
    // Execute the actual attach prelude against tmux. The old bare session
    // target fails here with 'no such window' despite an existing session.
    const prelude = bridge.args.slice(1, bridge.args.indexOf("attach-session") - 1);
    expect(await run(prelude)).toMatchObject({ code: 0, error: "" });
    expect((await run(["display-message", "-p", "-t", `${session}:`, "#{window_width}x#{window_height}"])).output.trim()).toBe("120x30");
    expect(bridge.args.slice(-4)).toEqual(["attach-session", "-r", "-t", session]);
  } finally { await run(["kill-server"]); }
});
