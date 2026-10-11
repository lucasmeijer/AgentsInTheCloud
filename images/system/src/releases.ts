import { Type } from "typebox";
import { Value } from "typebox/value";
import { readReleaseSettings, releaseReference, activeReleaseSource, selectedReleaseChannel, defaultReleaseSource } from "../../../packages/shared/src/release-source.ts";
import { resolveImage, type HttpFetcher, type PlannedImage } from "../../../packages/update/src/server/registry.ts";
import { createReleaseRegistry } from "./release-registry.ts";

/** Resolve every dependency before pulling; tags are restored only after the complete pinned plan succeeds. */
export async function prepareRelease(reference: string, images: {
  fetcher: HttpFetcher; pull(reference: string): Promise<void>; tag(pinned: string, alias: string): Promise<void>; inspect(reference: string): Promise<string>;
}) {
  const plans = new Map<string, PlannedImage>();
  const aliases = new Map<string, string>();
  async function discover(requested: string) {
    if (aliases.has(requested)) return;
    if (aliases.size >= 100) throw new Error("Release dependency limit exceeded");
    const plan = await resolveImage(requested, images.fetcher);
    aliases.set(requested, plan.reference);
    if (plans.has(plan.reference)) return;
    plans.set(plan.reference, plan);
    for (const dependency of plan.dependencies) await discover(dependency);
  }
  await discover(reference);
  for (const plan of plans.values()) await images.pull(plan.reference);
  for (const plan of plans.values()) await images.inspect(plan.reference);
  for (const [alias, pinned] of aliases) if (!alias.includes("@")) await images.tag(pinned, alias);
  const pinned = aliases.get(reference)!;
  return { imageId: await images.inspect(pinned), reference: pinned };
}

export function createReleaseRequests(options: {
  settingsPath: string;
  registry: ReturnType<typeof createReleaseRegistry>;
  busy(): boolean;
  prepare(reference: string): Promise<{ imageId: string; reference: string }>;
  fetcher?: HttpFetcher;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/release/")) return;
    try {
      if (url.pathname === "/release/registry") {
        if (request.method === "GET") return Response.json({ configured: await options.registry.configured() });
        if (options.busy()) return Response.json({ error: "An update is in progress" }, { status: 409 });
        if (request.method === "POST") { await options.registry.configure(request); return Response.json({ configured: true }); }
        if (request.method === "DELETE") { await options.registry.clear(); return Response.json({ configured: false }); }
      }
      const settings = await readReleaseSettings(options.settingsPath);
      if (url.pathname === "/release/source" && request.method === "GET") return Response.json({ source: settings.releaseSource ?? defaultReleaseSource, channel: selectedReleaseChannel(settings), configured: settings.releaseSource !== undefined, appReference: releaseReference(settings, "app"), systemReference: releaseReference(settings, "system") });
      if (url.pathname === "/release/check" && request.method === "GET") {
        const component = url.searchParams.get("component") ?? "app";
        if (component !== "app" && component !== "system") return Response.json({ error: "Unsupported release component" }, { status: 400 });
        const plan = await resolveImage(releaseReference(settings, component), await options.registry.fetcher(options.fetcher));
        return Response.json({ reference: plan.reference, digest: plan.reference.split("@")[1], revision: plan.revision, indexDigest: plan.indexDigest });
      }
      if (url.pathname === "/release/prepare" && request.method === "POST") {
        if (options.busy()) return Response.json({ error: "An update is in progress" }, { status: 409 });
        const value: unknown = await request.json();
        const source = activeReleaseSource(settings);
        if (!Value.Check(Type.Object({ reference: Type.String() }, { additionalProperties: false }), value) || !value.reference.startsWith(`${source.appRepository}@`) || !/^sha256:[a-f0-9]{64}$/.test(value.reference.slice(source.appRepository.length + 1))) return Response.json({ error: "Expected pinned image from the configured repository" }, { status: 400 });
        return Response.json(await options.prepare(value.reference));
      }
      return Response.json({ error: "Unknown release operation" }, { status: 404 });
    } catch {
      // Registry replies and credential parsers must not be reflected into HTTP or progress logs.
      return Response.json({ error: "Release operation failed. Check the source, registry access and System storage." }, { status: 502 });
    }
  };
}
