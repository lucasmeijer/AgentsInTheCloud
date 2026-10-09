import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const releaseRepositoryPattern = "^(?:ghcr\\.io|docker\\.io)/[a-z0-9]+(?:[._-][a-z0-9]+)*/[a-z0-9]+(?:[._/-][a-z0-9]+)*$";
export const releaseVersionPattern = "^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|sha256:[a-f0-9]{64})$";
export const releaseSourceSchema = Type.Object({
  appRepository: Type.String({ pattern: releaseRepositoryPattern }),
  systemRepository: Type.String({ pattern: releaseRepositoryPattern }),
  appVersion: Type.Optional(Type.String({ pattern: releaseVersionPattern })),
  systemVersion: Type.Optional(Type.String({ pattern: releaseVersionPattern })),
}, { additionalProperties: false });
export type ReleaseSource = Static<typeof releaseSourceSchema>;
export const defaultReleaseSource: ReleaseSource = { appRepository: "ghcr.io/lucasmeijer/agents-in-the-cloud", systemRepository: "ghcr.io/lucasmeijer/agents-in-the-cloud-system" };
export const releaseSettingsSchema = Type.Object({
  releaseChannel: Type.Optional(Type.Union([Type.Literal("stable"), Type.Literal("latest")])),
  releaseSource: Type.Optional(releaseSourceSchema),
  releaseMode: Type.Optional(Type.Union([Type.Literal("upstream"), Type.Literal("custom")])),
});
export type ReleaseSettings = Static<typeof releaseSettingsSchema>;

export async function readReleaseSettings(path: string): Promise<ReleaseSettings> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!Value.Check(releaseSettingsSchema, value)) throw new Error("Invalid release settings; refusing to select another source");
  if (value.releaseMode === "custom" && !value.releaseSource) throw new Error("Custom channel requires a release source");
  return value;
}

export function activeReleaseSource(settings: ReleaseSettings): ReleaseSource {
  if (settings.releaseMode === "upstream") return defaultReleaseSource;
  if (settings.releaseMode === "custom" && !settings.releaseSource) throw new Error("Custom channel requires a release source");
  return settings.releaseSource ?? defaultReleaseSource;
}
export function selectedReleaseChannel(settings: ReleaseSettings): "stable" | "latest" | "custom" {
  return settings.releaseMode !== "upstream" && settings.releaseSource ? "custom" : settings.releaseChannel ?? "latest";
}

export function releaseReference(settings: ReleaseSettings, component: "app" | "system"): string {
  const source = activeReleaseSource(settings);
  const version = component === "app" ? source.appVersion : source.systemVersion;
  const repository = component === "app" ? source.appRepository : source.systemRepository;
  const selected = version ?? settings.releaseChannel ?? "latest";
  return `${repository}${selected.startsWith("sha256:") ? "@" : ":"}${selected}`;
}

export function releaseSourceFromReferences(settings: ReleaseSettings, app?: string, system?: string): ReleaseSource {
  const source = { ...(settings.releaseSource ?? defaultReleaseSource) };
  for (const [component, reference] of [["app", app], ["system", system]] as const) {
    if (!reference) continue;
    const match = /^((?:ghcr\.io|docker\.io)\/[a-z0-9._/-]+)(?::([^/@]+)|@(sha256:[a-f0-9]{64}))?$/.exec(reference);
    if (!match) throw new Error("Explicit release images must use a GHCR or Docker Hub repository, tag or digest");
    const repository = match[1]!;
    const version = match[3] ?? match[2];
    if (component === "app") { source.appRepository = repository; source.appVersion = version; }
    else { source.systemRepository = repository; source.systemVersion = version; }
  }
  // Optional properties must be omitted when an override selects the channel rather than a pin.
  if (source.appVersion === undefined) delete source.appVersion;
  if (source.systemVersion === undefined) delete source.systemVersion;
  if (!Value.Check(releaseSourceSchema, source)) throw new Error("Invalid Docker release source");
  return source;
}

export const registryCredentialSchema = Type.Object({
  username: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_.-]+$" }),
  token: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\s:]+$", writeOnly: true }),
}, { additionalProperties: false });
export type RegistryCredentials = Static<typeof registryCredentialSchema>;
