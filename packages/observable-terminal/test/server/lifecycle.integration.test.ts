import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "@agents-in-the-cloud/core";
import { startWorkspaceProcess } from "@agents-in-the-cloud/workspace-helper";
import { resolveWorkspaceImage } from "@agents-in-the-cloud/workspace-image";
import { attachHostObservableTerminal, buildObservableSessionCommand, type ObservableTerminalConnection } from "../../src/server/index.ts";
import { attachObservableTerminal } from "../../src/server/attach.ts";

for (const remote of [false, true]) {
  describe.skip(`${remote ? "Docker" : "host"} terminal lifecycle`, () => {
    const container = `agents-in-the-cloud-terminal-test-${crypto.randomUUID()}`;
    // Built by `bun run --cwd packages/workspace-helper build`.
    const helper = new URL("../../../workspace-helper/workspace_tools/aitc-workspace-helper", import.meta.url).pathname;
    let socket = "";
    const sessions: string[] = [];
    const connections: ObservableTerminalConnection[] = [];

    async function command(args: string[]): Promise<string> {
      const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      if (code !== 0) throw new Error(`${args.join(" ")}: ${stderr} (exit ${code})`);
      return stdout.trim();
    }
    const run = (script: string) => command(remote
      ? ["docker", "exec", "--user", "agents-in-the-cloud", container, "sh", "-lc", script]
      : ["sh", "-lc", script]);
    async function until(read: () => Promise<string>, expected: string): Promise<void> {
      let actual = "";
      for (let i = 0; i < 100; i++) {
        actual = await read();
        if (actual === expected) return;
        await Bun.sleep(20);
      }
      expect(actual).toBe(expected);
    }
    async function create(command = "/bin/bash --noprofile --norc"): Promise<string> {
      const session = `terminal-lifecycle-${crypto.randomUUID()}`;
      sessions.push(session);
      await run(buildObservableSessionCommand({ session, cwd: "/tmp", command }));
      return session;
    }
    function attach(session: string, readonly = false) {
      const exited = Promise.withResolvers<number>();
      let output = "";
      const decoder = new TextDecoder();
      const events = {
        onData: (chunk: Uint8Array) => { output += decoder.decode(chunk, { stream: true }); },
        onExit: exited.resolve,
      };
      const options = { session, cols: 80, rows: 24, readonly };
      const connection = remote ? attachObservableTerminal({ ...options, start: (start) => startWorkspaceProcess(socket, start) }, events) : attachHostObservableTerminal(options, events);
      connections.push(connection);
      return { connection, exited: exited.promise, output: () => output };
    }
    const clients = (session: string) => run(`tmux list-clients -t ${session} -F '#{client_pid}'`);
    const count = async (session: string) => String((await clients(session)).split("\n").filter(Boolean).length);
    const size = (session: string) => run(`tmux display-message -p -t ${session} '#{pane_width}x#{pane_height}'`);

    beforeAll(async () => {
      if (remote) {
        const image = await resolveWorkspaceImage();
        const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-terminal-test-"));
        socket = join(directory, "helper.sock");
        await command(["docker", "run", "-d", "--init", "--name", container, "--user", "root", "-v", `${helper}:/helper:ro`, "-v", `${directory}:/run/agents-in-the-cloud-parent`, "--entrypoint", "/helper", image]);
        await until(async () => String(existsSync(socket)), "true");
      }
    }, 300_000);
    afterEach(async () => {
      for (const connection of connections.splice(0)) connection.close();
      for (const session of sessions.splice(0)) {
        await run(`tmux kill-session -t ${session} 2>/dev/null || true`);
        await run(`rm -f /tmp/${session}.*`);
      }
    });
    afterAll(async () => {
      if (remote) await command(["docker", "rm", "-f", container]);
    });

    test("resize reaches tmux; disconnect removes only its client and reconnect preserves the pane", async () => {
      const session = await create();
      const panePid = await run(`tmux display-message -p -t ${session} '#{pane_pid}'`);
      const first = attach(session);
      await until(() => count(session), "1");
      first.connection.resize(50, 40);
      await until(() => size(session), "50x40");
      const second = attach(session);
      await until(() => count(session), "2");
      first.connection.close();
      first.connection.close();
      await first.exited;
      await until(() => count(session), "1");
      second.connection.close();
      await second.exited;
      await until(() => count(session), "0");
      expect(await run(`tmux display-message -p -t ${session} '#{pane_pid}'`)).toBe(panePid);
      const third = attach(session);
      await until(() => count(session), "1");
      third.connection.resize(100, 30);
      await until(() => size(session), "100x30");
    }, 15_000);

    test("closing immediately during startup does not leak a client", async () => {
      const session = await create();
      const viewer = attach(session);
      viewer.connection.close();
      await viewer.exited;
      expect(await count(session)).toBe("0");
      expect(await run(`tmux has-session -t ${session} && printf alive`)).toBe("alive");
    }, 10_000);

    async function foregroundJob(session: string, connection: ObservableTerminalConnection) {
      const marker = `/tmp/${session}.job`;
      connection.write(`ulimit -c 0; sleep 300 & pid=$!; echo $pid > ${marker}; fg; echo $? > ${marker}.status\n`);
      await until(() => run(`test -f ${marker} && printf ready || true`), "ready");
      const pid = await run(`cat ${marker}`);
      const shellPid = await run(`tmux display-message -p -t ${session} '#{pane_pid}'`);
      await until(() => run(`ps -o tpgid= -p ${shellPid}`), pid);
      return { pid, status: () => run(`cat ${marker}.status 2>/dev/null || true`) };
    }

    test("Ctrl+C interrupts the foreground job, Ctrl+Z suspends it, and fg resumes it", async () => {
      const session = await create();
      const viewer = attach(session);
      await until(() => count(session), "1");
      const { pid } = await foregroundJob(session, viewer.connection);
      viewer.connection.write("\x1a");
      await until(() => run(`ps -o stat= -p ${pid} | cut -c1`), "T");
      viewer.connection.write("fg\n");
      await until(() => run(`ps -o stat= -p ${pid} | cut -c1`), "S");
      viewer.connection.write("\x03");
      await until(() => run(`if kill -0 ${pid} 2>/dev/null; then printf running; else printf exited; fi`), "exited");
      expect(await count(session)).toBe("1");
    }, 15_000);

    test("Ctrl+\\ sends SIGQUIT to the foreground job, not the attachment", async () => {
      const session = await create();
      const viewer = attach(session);
      await until(() => count(session), "1");
      const { status } = await foregroundJob(session, viewer.connection);
      viewer.connection.write("\x1c");
      await until(status, "131");
      expect(await count(session)).toBe("1");
    }, 10_000);

    test("Ctrl+D is terminal EOF, allowing a shell to exit normally", async () => {
      const session = await create();
      const viewer = attach(session);
      await until(() => count(session), "1");
      viewer.connection.write("\x04");
      expect(await viewer.exited).toBe(0);
    }, 10_000);

    test("raw mode receives control bytes instead of forced signals", async () => {
      const session = await create();
      const viewer = attach(session);
      await until(() => count(session), "1");
      const marker = `/tmp/${session}.raw`;
      const fixture = `import os,tty\ntty.setraw(0)\nopen('${marker}', 'w').write('ready')\ndata = b''\nwhile len(data) < 3: data += os.read(0, 3-len(data))\nopen('${marker}', 'w').write(data.hex())`;
      viewer.connection.write(`python3 -c ${shellQuote(fixture)}; stty sane\n`);
      await until(() => run(`cat ${marker} 2>/dev/null || true`), "ready");
      viewer.connection.write("\x03\x1a\x04");
      await until(() => run(`cat ${marker}`), "031a04");
    }, 10_000);

    test("readonly clients cannot interrupt a foreground program", async () => {
      const session = await create("sleep 300");
      const viewer = attach(session, true);
      await until(() => count(session), "1");
      viewer.connection.write("\x03\x1a");
      await Bun.sleep(100);
      expect(await run(`tmux display-message -p -t ${session} '#{pane_dead}'`)).toBe("0");
      viewer.connection.close();
      await viewer.exited;
      expect(await count(session)).toBe("0");
    }, 10_000);

    test("normal session exit closes the attachment and delivers final output", async () => {
      const session = await create();
      const viewer = attach(session);
      await until(() => count(session), "1");
      viewer.connection.write("printf 'FINAL-%s\\n' OUTPUT; exit\n");
      expect(await viewer.exited).toBe(0);
      expect(viewer.output()).toContain("FINAL-OUTPUT");
      viewer.connection.close();
    }, 10_000);

    test("an abruptly terminated attachment owner leaves no stale client", async () => {
      const session = await create();
      const modulePath = new URL("../../src/server/attach.ts", import.meta.url).pathname;
      const helperModulePath = new URL("../../../workspace-helper/src/index.ts", import.meta.url).pathname;
      const options = { session, cols: 80, rows: 24 };
      const owner = Bun.spawn(["bun", "-e", `import { attachObservableTerminal, attachHostObservableTerminal } from ${JSON.stringify(modulePath)};
        import { startWorkspaceProcess } from ${JSON.stringify(helperModulePath)};
        ${remote
          ? `attachObservableTerminal({ ...${JSON.stringify(options)}, start: (start) => startWorkspaceProcess(${JSON.stringify(socket)}, start) }, { onData() {}, onExit() {} });`
          : `attachHostObservableTerminal(${JSON.stringify(options)}, { onData() {}, onExit() {} });`}`],
        { stdout: "pipe", stderr: "pipe" });
      try {
        await until(() => count(session), "1");
        owner.kill("SIGKILL");
        await owner.exited;
        await until(() => count(session), "0");
        expect(await run(`tmux has-session -t ${session} && printf alive`)).toBe("alive");
      } finally {
        owner.kill();
      }
    }, 15_000);

    for (const signal of ["HUP", "TERM"]) {
      test(`SIG${signal} to the attachment detaches without stopping the session`, async () => {
        const session = await create("sleep 300");
        const viewer = attach(session);
        await until(() => count(session), "1");
        const clientPid = await clients(session);
        await run(`kill -${signal} ${clientPid}`);
        await viewer.exited;
        expect(await count(session)).toBe("0");
        expect(await run(`tmux display-message -p -t ${session} '#{pane_dead}'`)).toBe("0");
      }, 10_000);
    }

    test("SIGTERM to the foreground job does not terminate the viewer", async () => {
      const session = await create();
      const viewer = attach(session);
      await until(() => count(session), "1");
      const { pid, status } = await foregroundJob(session, viewer.connection);
      await run(`kill -TERM ${pid}`);
      await until(status, "143");
      expect(await count(session)).toBe("1");
    }, 10_000);

    if (remote) {
      test("an unreachable helper delivers diagnostics before exit", async () => {
        const exited = Promise.withResolvers<number>();
        const decoder = new TextDecoder();
        let output = "";
        attachObservableTerminal({ start: (start) => startWorkspaceProcess(`${socket}-missing`, start), session: "missing", cols: 80, rows: 24 }, {
          onData: (chunk) => { output += decoder.decode(chunk, { stream: true }); },
          onExit: exited.resolve,
        });
        expect(await exited.promise).not.toBe(0);
        expect(output).toContain("No connection established");
      });
    }

    test("explicitly killing the session ends all attachments", async () => {
      const session = await create();
      const first = attach(session);
      const second = attach(session);
      await until(() => count(session), "2");
      await run(`tmux kill-session -t ${session}`);
      await Promise.all([first.exited, second.exited]);
    }, 10_000);
  });
}
