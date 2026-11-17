import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { createWorkspaceIngress, StoppedWorkspaceError } from "@agents-in-the-cloud/proxy-ingress/server";
import { createMemoryOriginIdentityStore } from "../src/ingress/origin-identity.ts";
import { ensureTailscaleServePortConfig, pruneTailscaleServePortConfig, type TailscaleServeConfig } from "../src/ingress/tailscale-serve.ts";
import { normalizeDecodedFetchResponse } from "../src/ingress/index.ts";
import { type ParentOriginPublisher } from "../src/ingress/parent.ts";
import { closeWebSocket } from "../src/ingress/websocket.ts";

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = server.port!;
  server.stop(true);
  return port;
}

function recordingPublisher() {
  const active = new Set<number>();
  const calls: string[] = [];
  const publisher: ParentOriginPublisher = {
    kind: "localhost",
    async publish(port) { active.add(port); calls.push(`publish:${port}`); return `http://localhost:${port}`; },
    async unpublish(port) { active.delete(port); calls.push(`unpublish:${port}`); },

  };
  return { active, calls, publisher };
}

describe("workspace ingress", () => {
  test("does not forward reserved WebSocket close codes", () => {
    const calls: Array<[number?, string?]> = [];
    const socket = { close: (code?: number, reason?: string) => { calls.push([code, reason]); } };

    closeWebSocket(socket, 1005, "No Status Received");
    closeWebSocket(socket, 4001, "upstream done");

    expect(calls).toEqual([[undefined, undefined], [4001, "upstream done"]]);
  });

  test("publishes one stable origin per app and removes publication on deletion", async () => {
    const port = await freePort();
    const published = recordingPublisher();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      parentOriginPublisher: published.publisher,
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "fetch", fetch: () => new Response(`served:${url.pathname}`) }),
    });
    await ingress.initialize();

    const first = await ingress.openCanonical({ workspaceId: "ws", appKey: "demo" }, "/path?x=1");
    const second = await ingress.openCanonical({ workspaceId: "ws", appKey: "demo" }, "/other");

    expect(first.status).toBe(302);
    expect(new URL(first.headers.get("location")!).port).toBe(String(port));
    expect(new URL(second.headers.get("location")!).port).toBe(String(port));
    expect(published.calls).toEqual([`publish:${port}`]);
    expect(await (await fetch(first.headers.get("location")!)).text()).toBe("served:/path");
    expect(ingress.inspect()).toEqual([expect.objectContaining({ workspaceId: "ws", appKey: "demo", port, scope: "public" })]);

    await ingress.stopWorkspace("ws");
    expect(ingress.inspect()).toEqual([]);
    expect(published.active.size).toBe(0);
    await ingress.stopAll();
  });

  test("never reassigns a retained browser origin to another app", async () => {
    const start = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start, end: start + 1 },
      resolveWorkspace: () => undefined,
      resolveApp: () => ({ kind: "fetch", fetch: () => new Response("ok") }),
    });
    await ingress.initialize();
    const first = await ingress.openCanonical({ workspaceId: "ws", appKey: "first" }, "/");
    const firstPort = Number(new URL(first.headers.get("location")!).port);
    await ingress.stopWorkspace("ws");
    const second = await ingress.openCanonical({ workspaceId: "ws", appKey: "second" }, "/");
    const secondPort = Number(new URL(second.headers.get("location")!).port);
    expect(secondPort).not.toBe(firstPort);
    await ingress.stopWorkspace("ws");
    await ingress.stopAll();
  });

  test("streams HTTP requests with consistent local forwarding headers", async () => {
    let observed: { method: string; body: string; host: string | null; proto: string | null } | undefined;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        observed = {
          method: request.method,
          body: await request.text(),
          host: request.headers.get("x-forwarded-host"),
          proto: request.headers.get("x-forwarded-proto"),
        };
        return new Response("upstream", { status: 201, headers: { "x-app": "ok" } });
      },
    });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${upstream.port}`) }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical(
      { workspaceId: "ws", appKey: "demo" },
      "/submit?x=1",
    );
    const location = new URL(opened.headers.get("location")!);
    const response = await fetch(`http://127.0.0.1:${location.port}/submit?x=1`, { method: "POST", body: "payload", headers: { host: location.host } });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-app")).toBe("ok");
    expect(await response.text()).toBe("upstream");
    expect(observed).toEqual({ method: "POST", body: "payload", host: `localhost:${upstream.port}`, proto: "http" });

    await ingress.stopAll();
    upstream.stop(true);
  });

  test("preserves forms, redirects, cookies, downloads, custom headers, and byte ranges while bypassing read validators", async () => {
    let uploaded = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/form") {
          const form = await request.formData();
          // SAFETY: This acceptance request constructs the multipart field with a File below.
          const file = form.get("file") as File;
          uploaded = `${form.get("title")}:${await file.text()}`;
          return new Response("created", { status: 201 });
        }
        if (url.pathname === "/redirect") return new Response(null, { status: 307, headers: { location: "/final?ok=1" } });
        if (url.pathname === "/cookie") return new Response("cookie", { headers: { "set-cookie": "session=abc; Path=/; HttpOnly", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } });
        if (url.pathname === "/conditional") return request.headers.get("if-none-match") === `"v1"`
          ? new Response(null, { status: 304, headers: { etag: `"v1"`, "x-app-validator": "matched" } })
          : new Response("fresh", { headers: { etag: `"v1"` } });
        if (url.pathname === "/range") return new Response("2345", { status: 206, headers: { "content-range": "bytes 2-5/10", "accept-ranges": "bytes" } });
        if (url.pathname === "/download") return new Response("data", { headers: { "content-disposition": `attachment; filename="report.txt"` } });
        return new Response("not found", { status: 404 });
      },
    });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${upstream.port}`) }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical({ workspaceId: "ws", appKey: "web" }, "/");
    const origin = new URL(opened.headers.get("location")!).origin;
    const form = new FormData();
    form.set("title", "demo");
    form.set("file", new File(["payload"], "demo.txt"));
    expect((await fetch(`${origin}/form`, { method: "POST", body: form })).status).toBe(201);
    expect(uploaded).toBe("demo:payload");
    const redirect = await fetch(`${origin}/redirect`, { redirect: "manual" });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe(`${origin}/final?ok=1`);
    const cookie = await fetch(`${origin}/cookie`);
    expect(cookie.headers.get("set-cookie")).toContain("session=abc");
    expect(cookie.headers.get("x-frame-options")).toBeNull();
    expect(cookie.headers.get("content-security-policy")).toBe("default-src 'self'");
    const conditional = await fetch(`${origin}/conditional`, { headers: { "if-none-match": `"v1"` } });
    expect(conditional.status).toBe(200);
    expect(await conditional.text()).toBe("fresh");
    expect(conditional.headers.get("etag")).toBe('"v1"');
    expect(conditional.headers.get("cache-control")).toBe("no-store");
    const range = await fetch(`${origin}/range`, { headers: { range: "bytes=2-5" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await range.text()).toBe("2345");
    expect((await fetch(`${origin}/download`)).headers.get("content-disposition")).toContain("attachment");
    await ingress.stopAll();
    upstream.stop(true);
  });

  test("streams server-sent events and propagates response cancellation", async () => {
    let cancelled = false;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: ready\\ndata: 1\\n\\n"));
        },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } }),
    });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(url.pathname, `http://127.0.0.1:${upstream.port}`) }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical({ workspaceId: "ws", appKey: "events" }, "/events");
    const controller = new AbortController();
    const response = await fetch(opened.headers.get("location")!, { signal: controller.signal });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: ready");
    controller.abort();
    await expect(reader.cancel("done")).rejects.toBe(controller.signal.reason);
    await Bun.sleep(20);
    expect(cancelled).toBe(true);
    await ingress.stopAll();
    upstream.stop(true);
  });

  test("bridges text and binary WebSockets with subprotocol and clean closure propagation", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const offered = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()) ?? [];
        const headers = offered.includes("agents-in-the-cloud-test") ? { "sec-websocket-protocol": "agents-in-the-cloud-test" } : undefined;
        if (server.upgrade(request, { headers })) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          if (message === "close-cleanly") socket.close(4001, "upstream done");
          else socket.send(message);
        },
      },
    });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(url.pathname, `http://127.0.0.1:${upstream.port}`) }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical(
      { workspaceId: "ws", appKey: "socket" },
      "/echo",
    );
    const location = new URL(opened.headers.get("location")!);
    location.protocol = "ws:";
    const result = await new Promise<{ protocol: string; binary: number[]; closeCode: number; closeReason: string }>((resolve, reject) => {
      const socket = new WebSocket(location, ["agents-in-the-cloud-test"]);
      socket.binaryType = "arraybuffer";
      const timer = setTimeout(() => reject(new Error("WebSocket bridge timed out")), 2_000);
      let protocol = "";
      let binary: number[] = [];
      socket.addEventListener("open", () => {
        protocol = socket.protocol;
        socket.send(new Uint8Array([1, 2, 3]));
      });
      socket.addEventListener("message", (event) => {
        // SAFETY: binaryType is set to arraybuffer before the socket opens.
        binary = [...new Uint8Array(event.data as ArrayBuffer)];
        socket.send("close-cleanly");
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve({ protocol, binary, closeCode: event.code, closeReason: event.reason });
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket bridge failed")));
    });
    expect(result).toEqual({ protocol: "agents-in-the-cloud-test", binary: [1, 2, 3], closeCode: 4001, closeReason: "upstream done" });
    await ingress.stopAll();
    upstream.stop(true);
  });

  test("supports the 10-workspace, 10-app, 100-concurrent-connection baseline", async () => {
    const identities = createMemoryOriginIdentityStore();
    const assigned = new Set<number>();
    for (let workspace = 0; workspace < 10; workspace += 1) {
      for (let app = 0; app < 10; app += 1) {
        assigned.add((await identities.assignedPort({ workspaceId: `ws-${workspace}`, appKey: `app-${app}` }, { start: 46000, end: 46099 })).port);
      }
    }
    expect(assigned.size).toBe(100);

    let arrived = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: () => ({
        kind: "fetch",
        async fetch() {
          arrived += 1;
          await gate;
          return new Response("ok");
        },
      }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical({ workspaceId: "ws", appKey: "app" }, "/");
    const location = opened.headers.get("location")!;
    const responsePromises = Array.from({ length: 100 }, () => fetch(location));
    for (let attempt = 0; arrived < 100 && attempt < 100; attempt += 1) await Bun.sleep(10);
    expect(arrived).toBe(100);
    expect(ingress.inspect()[0]!.activeConnections).toBe(100);
    release?.();
    const responses = await Promise.all(responsePromises);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.text()));
    await ingress.stopAll();
  }, 15_000);

  test("distinguishes stopped workspaces and origin capacity exhaustion", async () => {
    const stoppedPort = await freePort();
    const stopped = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: stoppedPort, end: stoppedPort },
      resolveWorkspace: () => { throw new StoppedWorkspaceError("parked"); },
      resolveApp: () => ({ kind: "fetch", fetch: () => new Response("ok") }),
    });
    await stopped.initialize();
    const stoppedResponse = await stopped.openCanonical({ workspaceId: "parked", appKey: "demo" }, "/");
    expect(stoppedResponse.status).toBe(503);
    expect(await stoppedResponse.text()).toContain("Start the workspace");
    await stopped.stopAll();

    const capacityPort = await freePort();
    const capacity = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: capacityPort, end: capacityPort },
      resolveWorkspace: () => undefined,
      resolveApp: () => ({ kind: "fetch", fetch: () => new Response("ok") }),
    });
    await capacity.initialize();
    await capacity.openCanonical({ workspaceId: "ws", appKey: "first" }, "/");
    await capacity.stopWorkspace("ws");
    const exhausted = await capacity.openCanonical({ workspaceId: "ws", appKey: "second" }, "/");
    expect(exhausted.status).toBe(507);
    expect(await exhausted.text()).toContain("capacity exhausted");
    await capacity.stopAll();
  });

});

describe("decoded upstream response normalization", () => {
  test("removes metadata for a transparently decoded representation", async () => {
    const compressed = gzipSync("decoded JavaScript");
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(compressed, { headers: { "content-encoding": "gzip", "content-length": String(compressed.byteLength), etag: "\"encoded\"" } }),
    });
    const response = await fetch(`http://localhost:${upstream.port}`);
    upstream.stop();
    const normalized = normalizeDecodedFetchResponse(response);
    expect(await normalized.text()).toBe("decoded JavaScript");
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(normalized.headers.get("content-length")).toBeNull();
    expect(normalized.headers.get("etag")).toBeNull();
  });
});

describe("origin publication policy", () => {
  test("publishes active HTTPS origins without disturbing unrelated routes", () => {
    const config: TailscaleServeConfig = {
      TCP: { "443": { HTTPS: true } },
      Web: { "agents-in-the-cloud.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } } },
    };
    expect(ensureTailscaleServePortConfig(config, { host: "agents-in-the-cloud.tailnet.ts.net", port: 41000 })).toBe(true);
    expect(pruneTailscaleServePortConfig(config, { host: "agents-in-the-cloud.tailnet.ts.net", port: 41000 })).toBe(true);
    expect(config).toEqual({
      TCP: { "443": { HTTPS: true } },
      Web: { "agents-in-the-cloud.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } } },
    });
  });
});
