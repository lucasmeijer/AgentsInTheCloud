#!/usr/bin/env bun
/**
 * Runs a workspace process from a host terminal, the way `docker exec -it` did.
 * Usage: cli.ts <socket> <user> <workdir> <argv...>
 */
import { startWorkspaceProcess } from "./index.ts";

const [socket, user, workdir, ...argv] = process.argv.slice(2);
function usage(): never {
  console.error("usage: cli.ts <socket> <agents-in-the-cloud|root> <workdir> <argv...>");
  process.exit(2);
}
if (!socket || !workdir || argv.length === 0) usage();
if (user !== "agents-in-the-cloud" && user !== "root") usage();

const terminal = process.stdin.isTTY;
const size = () => ({ cols: process.stdout.columns, rows: process.stdout.rows });
const child = startWorkspaceProcess(socket, { argv, user, workdir, terminal: terminal ? size() : undefined });
if (terminal) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (data: Buffer) => child.write(data));
  process.stdout.on("resize", () => child.resize(size()));
}
// A hangup, e.g. from killing this terminal, ends the remote process too.
process.on("SIGHUP", () => child.cancel());
process.on("SIGTERM", () => child.cancel());

const copy = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) => {
  for await (const chunk of stream) target.write(chunk);
};
await Promise.all([copy(child.stdout, process.stdout), copy(child.stderr, process.stderr)]).catch(() => {});
try {
  const exit = await child.exited;
  process.exit(exit.signal === undefined ? exit.exitCode : 128 + exit.signal);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(255);
}
