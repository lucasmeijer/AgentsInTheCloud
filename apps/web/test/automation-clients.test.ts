import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managementOriginRejection } from "@agents-in-the-cloud/proxy-ingress/server";
import { preparePreview } from "../../../scripts/run-redesign-preview.ts";
import { startLightingTuner } from "../scripts/surface-lighting-tuner.ts";

interface FixtureViewReference { type: string; browserId?: string }
interface FixtureWorkspace {
  id: string; url: string; phase: { kind: string };
  agents: { id: string; agentTypeId: string; busy: boolean; title: string }[];
  workViews: { key: string; reference: FixtureViewReference }[];
}

function startManagement() {
  const requests: { method: string; path: string; origin: string | null; body: string }[] = [];
  const state: FixtureWorkspace = { id: "one", url: "/workspaces/one", phase: { kind: "runningPhase" }, agents: [], workViews: [] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const rejection = managementOriginRejection(request, server.requestIP(request)?.address);
      if (rejection) return rejection;
      const path = new URL(request.url).pathname;
      requests.push({ method: request.method, path, origin: request.headers.get("origin"), body: await request.text() });
      if (request.headers.get("upgrade") === "websocket") {
        if (server.upgrade(request)) return;
        return new Response("upgrade failed", { status: 400 });
      }
      if (path === "/workspaces" && request.method === "GET") return Response.json({ workspaces: [] });
      if (path === "/workspaces/one" && !request.headers.get("accept")?.includes("application/json")) return new Response("Fresh transcript");
      if (path === "/workspaces/one" || path === "/workspaces") return Response.json({ workspace: state });
      const command = path.split("/commands/")[1];
      if (command?.startsWith("agent.create.")) {
        const type = command.slice("agent.create.".length);
        state.agents.push({ id: type, agentTypeId: type, busy: false, title: type });
        return Response.json({ command: { agentId: type } });
      }
      if (command) {
        const type = command.split(".")[0]!;
        const reference: FixtureViewReference = { type };
        if (type === "browser") reference.browserId = "browser-one";
        state.workViews.push({ key: `${type}:one`, reference });
      }
      return Response.json({ ok: true });
    }, websocket: { message(socket, message) { socket.send(message); } },
  });
  return { server, origin: `http://127.0.0.1:${server.port}`, requests, state };
}

test("redesign staging sends destination Origin on every management command", async () => {
  const management = startManagement();
  try {
    expect(await preparePreview(management.origin)).toBe(`${management.origin}/workspaces/one?workView=browser%3Abrowser-one`);
    const posts = management.requests.filter(request => request.method === "POST");
    expect(posts.map(request => request.path)).toEqual([
      "/workspaces", "/workspaces/one/commands/browser.create", "/workspaces/one/commands/terminal.create",
      "/workspaces/one/commands/files.create", "/workspaces/one/commands/vscode.open",
    ]);
    for (const request of posts) expect(request.origin).toBe(management.origin);
  } finally { management.server.stop(true); }
});

test("acceptance staging sends Origin without requiring a real Docker workspace", async () => {
  const management = startManagement();
  const directory = await mkdtemp(join(tmpdir(), "management-automation-"));
  try {
    // The fixture's Docker executable only consumes the prompt-template input.
    // No container, model inference, or real workspace is started by this test.
    const docker = join(directory, "docker");
    await writeFile(docker, "#!/bin/sh\ncat >/dev/null\n");
    await chmod(docker, 0o755);
    const module = new URL("../../../acceptance/lib/stage.ts", import.meta.url).href;
    const process = Bun.spawn(["bun", "-e", `import { stage } from ${JSON.stringify(module)}; console.log(JSON.stringify(await stage({ atelier: ${JSON.stringify(management.origin)}, model: "test::model", log() {} })));`], {
      env: { ...globalThis.process.env, PATH: `${directory}:${globalThis.process.env.PATH}` },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(output)).toEqual({ atelier: management.origin, workspaceId: "one", builtinId: "builtin", piId: "pi", terminalKey: "terminal:one" });
    const posts = management.requests.filter(request => request.method === "POST");
    expect(posts.map(request => request.path)).toEqual([
      "/workspaces", "/workspaces/one/commands/agent.create.builtin", "/workspaces/one/agents/builtin/model", "/workspaces/one/agents/builtin/messages",
      "/workspaces/one/commands/agent.create.pi", "/workspaces/one/commands/terminal.create",
    ]);
    for (const request of posts) expect(request.origin).toBe(management.origin);
  } finally { management.server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 10_000);

test("lighting proxy translates only same-origin HTTP and WebSocket requests", async () => {
  const management = startManagement();
  management.state.workViews.push({ key: "terminal:one", reference: { type: "terminal" } });
  const tuner = await startLightingTuner(`${management.origin}/workspaces/one`, 0);
  const tunerOrigin = `http://127.0.0.1:${tuner.port}`;
  try {
    const response = await fetch(`${tunerOrigin}/workspaces/one/commands/terminal.create`, {
      method: "POST", headers: {
        Origin: tunerOrigin, "content-type": "application/json", "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example", "x-agents-in-the-cloud-origin-context": tunerOrigin,
      }, body: '{"title":"Shell"}',
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(management.requests.at(-1)).toEqual({
      method: "POST", path: "/workspaces/one/commands/terminal.create", origin: management.origin, body: '{"title":"Shell"}',
    });
    const count = management.requests.length;
    for (const origin of [undefined, "null", "https://attacker.example"]) {
      const headers = new Headers();
      if (origin) headers.set("origin", origin);
      const denied = await fetch(`${tunerOrigin}/workspaces/one/commands/terminal.create`, { method: "POST", headers });
      expect(denied.status).toBe(403);
      await denied.text();
      const upgrade = await fetch(`${tunerOrigin}/cable`, { headers: new Headers([...headers, ["upgrade", "websocket"]]) });
      expect(upgrade.status).toBe(403);
      await upgrade.text();
    }
    expect(management.requests).toHaveLength(count);
    // SAFETY: Bun's WebSocket constructor accepts headers for non-browser clients.
    const Socket = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket(tunerOrigin.replace("http:", "ws:") + "/cable", { headers: { Origin: tunerOrigin } });
      const timeout = setTimeout(() => { socket.close(); reject(new Error("WebSocket timeout")); }, 3000);
      socket.onopen = () => socket.send("hello");
      socket.onmessage = event => { expect(event.data).toBe("hello"); clearTimeout(timeout); socket.close(); resolve(); };
      socket.onerror = event => { clearTimeout(timeout); socket.close(); reject(event); };
    });
    expect(management.requests.at(-1)?.origin).toBe(management.origin);
    expect(management.requests.at(-1)?.path).toBe("/cable");
  } finally { tuner.stop(true); management.server.stop(true); }
});
