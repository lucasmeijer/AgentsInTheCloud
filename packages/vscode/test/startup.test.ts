import { expect, test } from "bun:test";
import { workspaceVSCodePort } from "@agents-in-the-cloud/workspace";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vscodeStartupScript } from "../src/server/startup.ts";

async function runStartup(port: number, identity?: { executable: string; entry: string }) {
  const directory = await mkdtemp(join(tmpdir(), "vscode-startup-"));
  try {
    const launcher = join(directory, "launcher");
    await writeFile(launcher, `#!/bin/sh\necho launched > '${directory}/launched'\nexit 42\n`, { mode: 0o755 });
    const script = vscodeStartupScript(join(directory, "workspace.code-workspace"))
      .replaceAll(String(workspaceVSCodePort), String(port))
      .replaceAll("/.agents-in-the-cloud/vscode", join(directory, "state"))
      .replaceAll("/opt/agents-in-the-cloud/bin/agents-in-the-cloud-start-vscode", launcher)
      .replaceAll("/opt/agents-in-the-cloud/vscode-server/node", identity?.executable ?? "/opt/agents-in-the-cloud/vscode-server/node")
      .replaceAll("/opt/agents-in-the-cloud/vscode-server/out/server-main.js", identity?.entry ?? "/opt/agents-in-the-cloud/vscode-server/out/server-main.js");
    const process = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    return { exitCode, stderr, launched: await Bun.file(join(directory, "launched")).exists() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const status of [200, 404, 503]) {
  test(`HTTP ${status} from another service is a conflict, not VS Code readiness`, async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("demo", { status }) });
    try {
      const result = await runStartup(server.port!);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("occupied by another service");
      expect(result.stderr).toContain("stop it yourself");
      expect(result.launched).toBe(false);
      expect(await (await fetch(server.url)).text()).toBe("demo");
    } finally { await server.stop(true); }
  });
}

test("a non-HTTP listener is a conflict without waiting for an HTTP timeout", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // SAFETY: This server was explicitly bound to a TCP port, not a Unix socket.
    const address = server.address() as AddressInfo;
    const result = await runStartup(address.port);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("occupied by another service");
    expect(result.launched).toBe(false);
    expect(server.listening).toBe(true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("a failed launcher is reported, not repeatedly restarted", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  await server.stop(true);
  const result = await runStartup(port);
  expect(result.exitCode).toBe(1);
  expect(result.launched).toBe(true);
  expect(result.stderr).toContain("exited during startup");
});

test("readiness reuses only the listener with the expected executable and entry point", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vscode-owned-listener-"));
  const entry = join(directory, "server.ts");
  await writeFile(entry, 'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready") }); process.stdout.write(String(server.port) + "\\n");');
  const child = Bun.spawn([process.execPath, entry], { stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const port = Number(new TextDecoder().decode(first.value).trim());
    expect(port).toBeGreaterThan(0);
    const executable = await readlink(`/proc/${child.pid}/exe`);
    const wrongEntry = await runStartup(port, { executable, entry: `${entry}.wrong` });
    expect(wrongEntry.exitCode).toBe(1);
    expect(wrongEntry.launched).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runStartup(port, { executable, entry });
      expect(result.exitCode).toBe(0);
      expect(result.launched).toBe(false);
    }
  } finally {
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
