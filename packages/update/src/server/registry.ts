import { type UpdateChannel } from "./update-channel.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const repository = "lucasmeijer/agents-in-the-cloud";

export type HttpFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ImageMetadata { digest: string; revision?: string; }

interface RegistryAuth { realm: string; service?: string; scope?: string }

const registryTokenResponseSchema = Type.Object({
  token: Type.Optional(Type.String()),
  access_token: Type.Optional(Type.String()),
});

const registryIndexSchema = Type.Object({
  manifests: Type.Array(Type.Object({
    digest: Type.String(),
    platform: Type.Optional(Type.Object({
      os: Type.Optional(Type.String()),
      architecture: Type.Optional(Type.String()),
    })),
  })),
});

const layerSchema = Type.Object({ digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), size: Type.Integer({ minimum: 0 }) });
const registryImageManifestSchema = Type.Object({
  config: Type.Object({ digest: Type.String() }),
  layers: Type.Array(layerSchema),
});

const registryManifestSchema = Type.Union([registryIndexSchema, registryImageManifestSchema]);

const registryConfigSchema = Type.Object({
  os: Type.String(),
  architecture: Type.String(),
  config: Type.Optional(Type.Union([
    Type.Object({
      Labels: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])),
    }),
    Type.Null(),
  ])),
});

export function parseWwwAuthenticate(header: string): RegistryAuth | undefined {
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  const out: RegistryAuth = { realm: "" };
  for (const part of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
    if (part[1] === "realm") out.realm = part[2];
    if (part[1] === "service") out.service = part[2];
    if (part[1] === "scope") out.scope = part[2];
  }
  return out.realm ? out : undefined;
}

async function fetchRegistryResponse(url: string, init: RequestInit, fetcher: HttpFetcher): Promise<Response> {
  const response = await fetcher(url, { ...init, redirect: "manual" });
  if (![301, 302, 303, 307, 308].includes(response.status)) return response;
  const original = new URL(url);
  const location = response.headers.get("location");
  if (!location || !original.pathname.includes("/blobs/")) throw new Error("Unexpected registry redirect");
  const destination = new URL(location, original);
  const allowed = original.hostname === "ghcr.io"
    ? destination.hostname === "pkg-containers.githubusercontent.com"
    : original.hostname === "registry-1.docker.io" && (destination.hostname === "production.cloudflare.docker.com" || destination.hostname.endsWith(".cloudflarestorage.com"));
  if (!allowed || destination.protocol !== "https:" || destination.username || destination.password || destination.port) throw new Error("Unsafe registry blob redirect");
  // Signed blob storage redirects are normal. Never forward the registry bearer token to storage.
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  try { return await fetcher(destination, { ...init, headers, redirect: "error" }); }
  catch { throw new Error("Registry blob download failed"); }
}

async function authFetch(url: string, init: RequestInit = {}, fetcher: HttpFetcher = fetch): Promise<Response> {
  const response = await fetchRegistryResponse(url, init, fetcher);
  if (response.status !== 401) return response;
  const auth = parseWwwAuthenticate(response.headers.get("www-authenticate") ?? "");
  if (!auth) return response;
  const tokenUrl = new URL(auth.realm);
  const registryUrl = new URL(url);
  const expectedOrigin = registryUrl.hostname === "registry-1.docker.io" ? "https://auth.docker.io" : registryUrl.origin;
  if (tokenUrl.origin !== expectedOrigin || tokenUrl.pathname !== "/token" || tokenUrl.username || tokenUrl.password) throw new Error("Unsafe registry authentication challenge");
  if (auth.service) tokenUrl.searchParams.set("service", auth.service);
  if (auth.scope) tokenUrl.searchParams.set("scope", auth.scope);
  const tokenResponse = await fetcher(tokenUrl, { headers: { accept: "application/json" }, redirect: "error" });
  if (!tokenResponse.ok) throw new Error(`registry token request failed: ${tokenResponse.status}`);
  const tokenJson = Value.Parse(registryTokenResponseSchema, await tokenResponse.json());
  const token = tokenJson.token ?? tokenJson.access_token;
  if (!token) throw new Error("registry token response did not include a token");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await fetchRegistryResponse(url, { ...init, headers }, fetcher);
}

function currentArch(): string {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

export function selectManifestFromIndex(index: Static<typeof registryIndexSchema>, platform = { os: "linux", architecture: currentArch() }): string {
  const manifest = index.manifests.find((candidate) => candidate.platform?.os === platform.os && candidate.platform?.architecture === platform.architecture);
  if (!manifest) throw new Error(`no ${platform.os}/${platform.architecture} manifest found`);
  return manifest.digest;
}

/** Shared registry protocol for update discovery and download planning. */
async function fetchRegistryImage(base: string, version: string, fetcher: HttpFetcher, platform: { os: string; architecture: string }) {
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  let response = await authFetch(`${base}/manifests/${version}`, { headers: { accept } }, fetcher);
  if (!response.ok) throw new Error(`registry manifest request failed: ${response.status}`);
  let digest = response.headers.get("docker-content-digest");
  const root = Value.Parse(registryManifestSchema, await response.json());
  let manifest: Static<typeof registryImageManifestSchema>;
  if ("manifests" in root) {
    digest = selectManifestFromIndex(root, platform);
    response = await authFetch(`${base}/manifests/${digest}`, { headers: { accept } }, fetcher);
    if (!response.ok) throw new Error(`registry platform manifest request failed: ${response.status}`);
    manifest = Value.Parse(registryImageManifestSchema, await response.json());
  } else manifest = root;
  const configResponse = await authFetch(`${base}/blobs/${manifest.config.digest}`, { headers: { accept: "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json" } }, fetcher);
  if (!configResponse.ok) throw new Error(`registry config request failed: ${configResponse.status}`);
  const config = Value.Parse(registryConfigSchema, await configResponse.json());
  if (config.os !== platform.os || config.architecture !== platform.architecture) {
    throw new Error(`update image is ${config.os}/${config.architecture}, expected ${platform.os}/${platform.architecture}`);
  }
  if (!digest) throw new Error("Registry did not return an immutable image digest");
  return { digest, layers: manifest.layers, labels: config.config?.Labels ?? {} };
}

export async function fetchChannelImageMetadata(channel: UpdateChannel, fetcher: HttpFetcher = fetch, platform = { os: "linux", architecture: currentArch() }): Promise<ImageMetadata> {
  const image = await fetchRegistryImage(`https://ghcr.io/v2/${repository}`, channel, fetcher, platform);
  return { digest: image.digest, revision: image.labels["org.opencontainers.image.revision"] };
}

const imageReferenceSchema = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$" });

export interface PlannedImage {
  reference: string;
  layers: Static<typeof layerSchema>[];
  dependencies: string[];
}

/** Read only manifests and configuration; no image layers are downloaded here. */
export async function resolveImage(reference: string, fetcher: HttpFetcher = fetch, platform = { os: "linux", architecture: currentArch() }): Promise<PlannedImage> {
  Value.Assert(imageReferenceSchema, reference);
  const parts = reference.split("/");
  const explicitRegistry = parts.length > 1 && (parts[0]!.includes(".") || parts[0]!.includes(":") || parts[0] === "localhost");
  const registry = explicitRegistry ? parts.shift()! : "docker.io";
  let name = parts.join("/");
  const separator = name.includes("@") ? name.indexOf("@") : name.lastIndexOf(":");
  const version = separator === -1 ? "latest" : name.slice(separator + 1);
  name = separator === -1 ? name : name.slice(0, separator);
  if (reference.includes("@") && name.includes(":")) name = name.slice(0, name.lastIndexOf(":"));
  if (registry === "docker.io" && !name.includes("/")) name = `library/${name}`;
  const host = registry === "docker.io" ? "registry-1.docker.io" : registry;
  const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  const base = `${protocol}://${host}/v2/${name}`;
  const image = await fetchRegistryImage(base, version, fetcher, platform);
  const dependencies = Value.Parse(Type.Array(imageReferenceSchema), JSON.parse(image.labels["eagerly-preload"] ?? "[]"));
  // Preserve an explicitly selected index digest so Docker also registers that declared reference.
  const pinnedDigest = reference.includes("@") ? version : image.digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(pinnedDigest)) throw new Error("Invalid image digest");
  return { reference: `${registry}/${name}@${pinnedDigest}`, layers: image.layers, dependencies };
}
