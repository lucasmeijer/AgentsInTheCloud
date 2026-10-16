import { expect, test } from "bun:test";
import { join } from "node:path";
import { terminalSocketDimensions } from "../../src/server/socket.ts";

async function scenario(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    const output = [], writes = [], sizes = [], progress = [];
    let callbacks, attachError, detachCount = 0, closeCount = 0;
    mock.module(${JSON.stringify(join(import.meta.dir, "../../src/server/attach.ts"))}, () => ({ attachObservableTerminal: (_options, events) => {
      if (attachError) throw attachError;
      callbacks = events;
      return { write: text => writes.push(text), resize: (...size) => sizes.push(size), close: () => detachCount++ };
    } }));
    const { createObservableTerminalSocket } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/socket.ts"))});
    const socket = { send: chunk => output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)), close: () => output.push("closed") };
    const options = { start: () => { throw new Error("unused"); }, session: "terminal", cols: 80, rows: 24 };
    ${script}
  `], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}

test("socket dimensions accept only bounded positive integers", () => {
  expect(terminalSocketDimensions(new URL("http://localhost/?cols=120&rows=40"))).toEqual({ cols: 120, rows: 40 });
  for (const value of ["", "NaN", "-1", "0", "1.5", "1001"]) {
    expect(terminalSocketDimensions(new URL(`http://localhost/?cols=${value}&rows=${value}`))).toEqual({ cols: 80, rows: 24 });
  }
});

test("interactive sockets route input, size and progress, and detach once", () => scenario(`
  const connection = createObservableTerminalSocket(options, { onProgress: event => progress.push(event), onClose: () => closeCount++ });
  connection.open(socket);
  connection.message(socket, "hello");
  connection.message(socket, new TextEncoder().encode("world"));
  connection.message(socket, JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
  connection.message(socket, JSON.stringify({ type: "progress", state: 1, value: 50 }));
  expect(writes).toEqual(["hello", "world"]);
  expect(sizes).toEqual([[100, 40]]);
  expect(progress).toEqual([{ type: "progress", state: 1, value: 50 }]);
  connection.close();
  expect(closeCount).toBe(1);
  connection.close();
  expect(detachCount).toBe(1);
`));

test("read-only sockets ignore input and control messages", () => scenario(`
  const connection = createObservableTerminalSocket({ ...options, readonly: true, fixedSize: true }, { onProgress: event => progress.push(event) });
  connection.open(socket);
  for (const text of ["interrupt", JSON.stringify({ type: "resize", cols: 1, rows: 1 }), JSON.stringify({ type: "progress", state: 1 })]) connection.message(socket, text);
  expect(writes).toEqual([]);
  expect(sizes).toEqual([]);
  expect(progress).toEqual([]);
  callbacks.onData(new TextEncoder().encode("final output"));
  callbacks.onExit(0);
  expect(output).toEqual(["final output", "closed"]);
`));

test("fixed-size interactive sockets accept input without resizing", () => scenario(`
  const connection = createObservableTerminalSocket({ ...options, fixedSize: true });
  connection.open(socket);
  connection.message(socket, "input");
  connection.message(socket, JSON.stringify({ type: "resize", cols: 1, rows: 1 }));
  expect(writes).toEqual(["input"]);
  expect(sizes).toEqual([]);
`));

test("attachment failure delivers its diagnostic before closing", () => scenario(`
  attachError = new Error("spawn failed");
  const connection = createObservableTerminalSocket(options);
  connection.open(socket);
  expect(output).toEqual(["\\r\\n[terminal attach failed: spawn failed]\\r\\n", "closed"]);
  connection.close();
  expect(detachCount).toBe(0);
`));

test("missing execution closes with the ended code without attaching or printing errors", () => scenario(`
  const closed = [];
  socket.close = (...args) => closed.push(args);
  const connection = createObservableTerminalSocket(options, { sessionExists: async () => false });
  await connection.open(socket);
  expect(callbacks).toBeUndefined();
  expect(output).toEqual([]);
  expect(closed).toEqual([[4404, "session-missing"]]);
`));

test("execution removed while attached delivers final output then signals ended", () => scenario(`
  let exists = true;
  const closed = [];
  socket.close = (...args) => closed.push(args);
  const connection = createObservableTerminalSocket(options, { sessionExists: async () => exists });
  await connection.open(socket);
  callbacks.onData(new TextEncoder().encode("last output"));
  exists = false;
  callbacks.onExit(0);
  await Bun.sleep(0);
  expect(output).toEqual(["last output"]);
  expect(closed).toEqual([[4404, "session-missing"]]);
`));

test("attachment exit with an existing execution remains reconnectable", () => scenario(`
  const closed = [];
  socket.close = (...args) => closed.push(args);
  const connection = createObservableTerminalSocket(options, { sessionExists: async () => true });
  await connection.open(socket);
  callbacks.onExit(1);
  await Bun.sleep(0);
  expect(closed).toEqual([[undefined, undefined]]);
`));

test("disconnect during the existence check never attaches a leaked client", () => scenario(`
  let resolveExists;
  const connection = createObservableTerminalSocket(options, { sessionExists: () => new Promise(resolve => resolveExists = resolve) });
  const opening = connection.open(socket);
  connection.close();
  resolveExists(true);
  await opening;
  expect(callbacks).toBeUndefined();
  expect(output).toEqual([]);
`));
