import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminStore } from "../src/server/admin/store.ts";
import { createAdminHandler, startOptionalAdminBindings } from "../src/server/admin/bindings.ts";
import { createAdminAudit } from "../src/server/admin/audit.ts";
import { matchAdminRoute } from "../src/server/admin/routes.ts";
import { adminOpenApi } from "../src/server/admin/openapi.ts";
import { adminRoutes } from "../src/server/admin/routes.ts";
import { adminInputSchema } from "../src/server/admin/schemas.ts";
import { agentsInTheCloudOpenApi } from "../src/server/openapi.ts";
import { Value } from "typebox/value";

async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "aitc-audit-fixes-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("exact literal routes reject OpenAPI lookalikes", () => {
  expect(matchAdminRoute("GET", "/openapi.json")?.path).toBe("/openapi.json");
  for (const path of ["/openapiXjson", "/openapi-json", "/openapi/json", "/workspaces/"]) expect(matchAdminRoute("GET", path)).toBeUndefined();
});

test("every mutation validates the same schema that OpenAPI documents", () => {
  const spec = adminOpenApi(JSON.parse(JSON.stringify(agentsInTheCloudOpenApi([]))), adminRoutes);
  for (const route of adminRoutes.filter(route => route.method !== "GET")) {
    const schema = adminInputSchema(route);
    expect(spec.paths[route.path]![route.method.toLowerCase()]!.requestBody!.content["application/json"]!.schema).toEqual(schema);
    expect(Value.Check(schema, { unexpected: "field" })).toBe(false);
  }
});

test("workspace creation rejects unknown top-level, source and agent fields", () => isolated(async directory => {
  const store = createAdminStore(join(directory, "config.json"));
  const issued = await store.issue({ name: "lifecycle", scopes: ["workspaces"] });
  let dispatches = 0;
  const handler = createAdminHandler({ store, auditPath: join(directory, "audit"), app: { fetch: async () => { dispatches++; return Response.json({}); } } });
  for (const body of [{ unknown: 1 }, { source: { type: "empty", unknown: 1 } }, { agent: { extra: "injection" } }, { force: "true" }, { agent: { model: 3 } }]) {
    const result = await handler(new Request("http://local/workspaces", { method: "POST", headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(result.status).toBe(400);
  }
  expect(dispatches).toBe(0);
}));

test("token expiry accepts only real UTC ISO timestamps", () => isolated(async directory => {
  const store = createAdminStore(join(directory, "config.json"));
  for (const expiresAt of ["Jan 1 2099", "2099-02-30T00:00:00Z", "2099-01-01", "2099-01-01T00:00:00+02:00", "2099-01-01T00:00:00.12Z"]) await expect(store.issue({ name: "expiry", scopes: ["host:read"], expiresAt })).rejects.toThrow();
  expect((await store.issue({ name: "expiry", scopes: ["host:read"], expiresAt: "2099-01-01T00:00:00Z" })).token.expiresAt).toBe("2099-01-01T00:00:00Z");
}));

test("corrupt config or invalid TLS disables only optional admin listeners", () => isolated(async directory => {
  const errors: Error[] = [];
  const config = join(directory, "config.json");
  const store = createAdminStore(config);
  const options = { store, auditPath: join(directory, "audit"), app: { fetch: async () => Response.json({}) }, reportError: (error: Error) => { errors.push(error); } };
  await writeFile(config, "invalid JSON");
  expect(await startOptionalAdminBindings(options)).toEqual([]);
  await rm(config);
  await store.setBindings([{ host: "0.0.0.0", port: 34567, tls: { cert: join(directory, "missing"), key: join(directory, "missing") } }]);
  expect(await startOptionalAdminBindings(options)).toEqual([]);
  expect(errors).toHaveLength(2);
  const ui = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("healthy") });
  try { expect(await (await fetch(`http://127.0.0.1:${ui.port}/up`)).text()).toBe("healthy"); }
  finally { ui.stop(true); }
}));

test("occupied admin port is isolated and partial listeners roll back", () => isolated(async directory => {
  let occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  while (occupied.port! >= 41000 && occupied.port! <= 41999) {
    occupied.stop(true);
    occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  }
  try {
    const store = createAdminStore(join(directory, "config.json"));
    await store.setBindings([{ host: "127.0.0.1", port: occupied.port! }]);
    expect(await startOptionalAdminBindings({ store, auditPath: join(directory, "audit"), app: { fetch: async () => Response.json({}) }, reportError: () => {} })).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${occupied.port}`)).status).toBe(200);
  } finally { occupied.stop(true); }
}));

test("bounded audit rotates a single backup and serializes concurrent writes", () => isolated(async directory => {
  const path = join(directory, "audit");
  const write = createAdminAudit(path, 1024);
  await Promise.all(Array.from({ length: 30 }, (_, index) => write({ requestId: String(index), tokenId: null, transportPeer: "127.0.0.1", method: "GET", operation: null, status: 401, phase: "rejected" })));
  for (const file of [path, `${path}.1`]) {
    const text = await readFile(file, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
    for (const line of text.trim().split("\n")) expect(JSON.parse(line)).toHaveProperty("requestId");
  }
}));

test("unauthenticated flood is rate limited with bounded rejection logging", () => isolated(async directory => {
  const store = createAdminStore(join(directory, "config.json"));
  const path = join(directory, "audit");
  const handler = createAdminHandler({ store, auditPath: path, app: { fetch: async () => { throw new Error("must not dispatch"); } } });
  for (let index = 0; index < 140; index++) {
    const response = await handler(new Request("http://local/workspaces"), "127.0.0.1");
    expect(response.status).toBe(index < 120 ? 401 : 429);
    if (response.status === 429) expect(response.headers.get("retry-after")).toBe("60");
  }
  expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
}));

test("audit admission failure prevents mutation", () => isolated(async directory => {
  const store = createAdminStore(join(directory, "config.json"));
  const token = await store.issue({ name: "test", scopes: ["workspaces"] });
  const broken = join(directory, "not-a-directory");
  await writeFile(broken, "file");
  let mutations = 0;
  const handler = createAdminHandler({ store, auditPath: join(broken, "audit"), app: { fetch: async () => { mutations++; return Response.json({}); } }, reportError: () => {} });
  const response = await handler(new Request("http://local/workspaces", { method: "POST", headers: { authorization: `Bearer ${token.secret}`, "content-type": "application/json" }, body: "{}" }));
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("audit_unavailable");
  expect(mutations).toBe(0);
}));

test("audit completion failure never disguises successful mutation as an API failure", () => isolated(async directory => {
  const store = createAdminStore(join(directory, "config.json"));
  const token = await store.issue({ name: "test", scopes: ["workspaces"] });
  const path = join(directory, "audit");
  const handler = createAdminHandler({ store, auditPath: path, app: { fetch: async () => {
    await rm(path); await mkdir(path);
    return Response.json({ created: true }, { status: 202 });
  } }, reportError: () => {} });
  const response = await handler(new Request("http://local/workspaces", { method: "POST", headers: { authorization: `Bearer ${token.secret}`, "content-type": "application/json" }, body: "{}" }));
  expect(response.status).toBe(202);
  expect(response.headers.get("x-admin-audit-warning")).toBe("completion-record-unavailable");
  expect(await response.json()).toEqual({ created: true });
}));

test("Host error code survives sanitization without leaking diagnostic messages", () => isolated(async directory => {
  const store = createAdminStore(join(directory, "config.json"));
  const token = await store.issue({ name: "test", scopes: ["host:read"] });
  const handler = createAdminHandler({ store, auditPath: join(directory, "audit"), app: { fetch: async () => Response.json({ error: { code: "host_unavailable", message: "sensitive-detail" } }, { status: 503 }) } });
  const response = await handler(new Request("http://local/host", { headers: { authorization: `Bearer ${token.secret}` } }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "host_unavailable", message: "Management operation failed" } });
}));

test("TLS private-key permissions, invalid PEM and unavailable addresses cannot kill the UI", () => isolated(async directory => {
  const store = createAdminStore(join(directory, "config.json"));
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  await writeFile(key, "not PEM", { mode: 0o644 });
  await writeFile(cert, "not PEM");
  const options = { store, auditPath: join(directory, "audit"), app: { fetch: async () => Response.json({}) }, reportError: () => {} };
  await store.setBindings([{ host: "0.0.0.0", port: 34566, tls: { cert, key } }]);
  expect(await startOptionalAdminBindings(options)).toEqual([]);
  const { chmod } = await import("node:fs/promises");
  await chmod(key, 0o600);
  expect(await startOptionalAdminBindings(options)).toEqual([]);
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdout: "pipe", stderr: "pipe" });
  expect(generated.exitCode).toBe(0);
  await store.setBindings([{ host: "192.0.2.1", port: 34566, tls: { cert, key } }]);
  expect(await startOptionalAdminBindings(options)).toEqual([]);
}));
