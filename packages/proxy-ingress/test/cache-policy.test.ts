import { expect, test } from "bun:test";
import { createWorkspaceIngress } from "@agents-in-the-cloud/proxy-ingress/server";

for (const kind of ["fetch", "http"] as const) {
  test(`${kind} previews bypass read validators and prevent caching every response`, async () => {
    const seen: Array<{ method: string; headers: Headers }> = [];
    const serve = (request: Request) => {
      seen.push({ method: request.method, headers: new Headers(request.headers) });
      const status = Number(new URL(request.url).searchParams.get("status") ?? "200");
      const headers = new Headers({
        "cache-control": "public, max-age=31536000, immutable",
        "expires": "Thu, 31 Dec 2037 23:55:55 GMT",
        "etag": '"current"',
        "set-cookie": "session=kept; Path=/; HttpOnly",
      });
      if (status === 302) headers.set("location", "/latest");
      return new Response(request.method === "HEAD" ? null : "fresh bytes", { status, headers });
    };
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serve });
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      resolveWorkspace() {},
      resolveApp(_app, url) {
        return kind === "fetch"
          ? { kind, fetch: serve }
          : {
            kind,
            target: new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${upstream.port}`),
            adaptResponse(response) {
              response.headers.set("cache-control", "max-age=86400");
              return response;
            },
          };
      },
    });
    try {
      const opened = await ingress.openCanonical({ workspaceId: "ws", appKey: "demo" }, "/");
      const origin = new URL(opened.headers.get("location")!).origin;
      for (const [method, path] of [
        ["GET", "/"], ["GET", "/app.js"], ["GET", "/style.css"],
        ["HEAD", "/app.js"], ["GET", "/?status=302"], ["GET", "/?status=500"],
      ]) {
        const response = await fetch(`${origin}${path}`, {
          method,
          redirect: "manual",
          headers: {
            "if-none-match": '"old"',
            "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT",
            "cache-control": "max-age=3600",
            "cookie": "session=kept",
          },
        });
        expect(response.status).toBe(Number(new URL(`${origin}${path}`).searchParams.get("status") ?? "200"));
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("set-cookie")).toContain("session=kept");
        expect(response.headers.get("clear-site-data")).toBeNull();
        expect(await response.text()).toBe(method === "HEAD" ? "" : "fresh bytes");
        const observed = seen.at(-1)!;
        expect(observed.headers.get("if-none-match")).toBeNull();
        expect(observed.headers.get("if-modified-since")).toBeNull();
        expect(observed.headers.get("cache-control")).toBe("no-cache");
        expect(observed.headers.get("cookie")).toBe("session=kept");
      }
      for (const method of ["PUT", "GET"]) {
        const response = await fetch(`${origin}/data`, {
          method,
          headers: {
            "if-match": '"current"',
            "if-unmodified-since": "Wed, 01 Jan 2025 00:00:00 GMT",
            "if-none-match": '"old"',
            "range": "bytes=0-3",
            "if-range": '"current"',
          },
        });
        await response.text();
        const observed = seen.at(-1)!;
        expect(observed.headers.get("if-match")).toBe('"current"');
        expect(observed.headers.get("if-unmodified-since")).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
        expect(observed.headers.get("range")).toBe("bytes=0-3");
        expect(observed.headers.get("if-range")).toBe('"current"');
        expect(observed.headers.get("if-none-match")).toBe(method === "PUT" ? '"old"' : null);
      }
    } finally {
      await ingress.stopAll();
      upstream.stop(true);
    }
  });
}
