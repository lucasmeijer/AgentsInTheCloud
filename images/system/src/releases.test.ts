import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReleaseSettings, releaseReference, releaseSourceFromReferences } from "../../../packages/shared/src/release-source.ts";
import { createReleaseRegistry } from "./release-registry.ts";
import { prepareRelease } from "./releases.ts";
import { resolveImage } from "../../../packages/update/src/server/registry.ts";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const value = await mkdtemp(join(tmpdir(), "release-test-")); directories.push(value); return value; }
const digest = `sha256:${"a".repeat(64)}`;

test("fork repositories, channels and pins remain independent of upstream", async () => {
  const path = join(await directory(), "update.json");
  const releaseSource = releaseSourceFromReferences({}, "ghcr.io/example/app:v2", `ghcr.io/example/system@${digest}`);
  await writeFile(path, JSON.stringify({ releaseChannel: "stable", releaseSource }));
  const settings = await readReleaseSettings(path);
  expect(releaseReference(settings, "app")).toBe("ghcr.io/example/app:v2");
  expect(releaseReference(settings, "system")).toBe(`ghcr.io/example/system@${digest}`);
  delete releaseSource.appVersion;
  expect(releaseReference({ releaseChannel: "stable", releaseSource }, "app")).toBe("ghcr.io/example/app:stable");
});

test("malformed configured sources fail closed", async () => {
  const path = join(await directory(), "update.json");
  for (const releaseSource of [null, {}, { appRepository: "ghcr.io/example/app", systemRepository: "http://elsewhere/image" }]) {
    await writeFile(path, JSON.stringify({ releaseSource }));
    await expect(readReleaseSettings(path)).rejects.toThrow();
  }
  expect(() => releaseSourceFromReferences({}, "ghcr.io/example/app:bad pin")).toThrow();
});

test("private credentials have restrictive permissions and never go to manifests or other registries", async () => {
  const path = join(await directory(), "private");
  const registry = createReleaseRegistry(path);
  await registry.configure(new Request("http://localhost", { method: "POST", body: JSON.stringify({ username: "test-user", token: "test-token" }) }));
  expect((await stat(path)).mode & 0o777).toBe(0o700);
  expect((await stat(`${path}/config.json`)).mode & 0o777).toBe(0o600);
  expect(await registry.configured()).toBe(true);
  const calls: RequestInit[] = [];
  const fetcher = await registry.fetcher(async (_url, init) => { calls.push(init!); return new Response(); });
  await fetcher("https://ghcr.io/token");
  await fetcher("https://ghcr.io/v2/example/app/manifests/latest");
  await fetcher("https://other.example/token");
  expect(new Headers(calls[0]!.headers).get("authorization")).toStartWith("Basic ");
  expect(new Headers(calls[1]!.headers).has("authorization")).toBe(false);
  expect(new Headers(calls[2]!.headers).has("authorization")).toBe(false);
  expect(calls.every(call => call.redirect === "error")).toBe(true);
  await registry.clear();
  expect(await registry.configured()).toBe(false);
  expect(await readFile(`${path}/config.json`, "utf8")).not.toContain("test-token");
});

test("foreign registry authentication challenges are rejected before requesting tokens", async () => {
  let count = 0;
  await expect(resolveImage("ghcr.io/example/app:latest", async () => {
    count++;
    return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://attacker.example/token"' } });
  })).rejects.toThrow("Unsafe registry authentication challenge");
  expect(count).toBe(1);
});

test("the complete dependency plan is pinned before any pull or alias mutation", async () => {
  const events: string[] = [];
  const result = await prepareRelease("ghcr.io/example/app:stable", {
    fetcher: async input => {
      const url = String(input); events.push(`fetch:${url}`);
      if (url.includes("/manifests/")) return Response.json({ config: { digest }, layers: [] }, { headers: { "docker-content-digest": digest } });
      return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: { Labels: { "eagerly-preload": url.includes("/example/app/") ? JSON.stringify(["ghcr.io/example/workspace:version"]) : "[]" } } });
    },
    pull: async reference => { events.push(`pull:${reference}`); },
    tag: async (reference, alias) => { events.push(`tag:${reference}:${alias}`); },
    inspect: async reference => { events.push(`inspect:${reference}`); return "image-id"; },
  });
  expect(result).toEqual({ imageId: "image-id", reference: `ghcr.io/example/app@${digest}` });
  const firstPull = events.findIndex(event => event.startsWith("pull:"));
  expect(events.slice(firstPull).some(event => event.startsWith("fetch:"))).toBe(false);
  expect(events.filter(event => event.startsWith("pull:"))).toEqual([`pull:ghcr.io/example/app@${digest}`, `pull:ghcr.io/example/workspace@${digest}`]);
});

test("dependency resolution failures happen before any image pull or tag change", async () => {
  let mutations = 0;
  await expect(prepareRelease("ghcr.io/example/app:stable", {
    fetcher: async input => {
      const url = String(input);
      if (url.includes("/workspace/")) return new Response(null, { status: 403 });
      if (url.includes("/manifests/")) return Response.json({ config: { digest }, layers: [] }, { headers: { "docker-content-digest": digest } });
      return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: { Labels: { "eagerly-preload": '["ghcr.io/example/workspace:version"]' } } });
    },
    pull: async () => { mutations++; }, tag: async () => { mutations++; }, inspect: async () => "unused",
  })).rejects.toThrow();
  expect(mutations).toBe(0);
});

test("signed GHCR blob redirects do not receive the registry bearer token", async () => {
  let storageRequests = 0;
  await resolveImage("ghcr.io/example/app:stable", async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "pkg-containers.githubusercontent.com") {
      storageRequests++;
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      return Response.json({ os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64", config: {} });
    }
    if (url.pathname === "/token") { expect(init?.redirect).toBe("error"); return Response.json({ token: "registry-bearer" }); }
    if (!new Headers(init?.headers).has("authorization")) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token"' } });
    if (url.pathname.includes("/manifests/")) return Response.json({ config: { digest }, layers: [] }, { headers: { "docker-content-digest": digest } });
    return new Response(null, { status: 307, headers: { location: "https://pkg-containers.githubusercontent.com/signed-blob" } });
  });
  expect(storageRequests).toBe(1);
});

test("registry blob redirects to foreign hosts are rejected", async () => {
  let foreignRequests = 0;
  await expect(resolveImage("ghcr.io/example/app:stable", async input => {
    const url = new URL(String(input));
    if (url.hostname !== "ghcr.io") foreignRequests++;
    if (url.pathname.includes("/manifests/")) return Response.json({ config: { digest }, layers: [] }, { headers: { "docker-content-digest": digest } });
    return new Response(null, { status: 307, headers: { location: "https://attacker.example/config" } });
  })).rejects.toThrow("Unsafe registry blob redirect");
  expect(foreignRequests).toBe(0);
});
