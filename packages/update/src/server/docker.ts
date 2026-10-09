import { resolveImage, type PlannedImage } from "./registry.ts";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { hostname } from "node:os";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export interface DockerExecResult { stdout: string; stderr: string; code: number }
export interface DockerExec { (args: string[]): Promise<DockerExecResult> }

export const dockerExec: DockerExec = async (args) => {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
};

export function parseContainerIdFromCgroup(text: string): string | undefined {
  const patterns = [
    /(?:^|[/:])docker[-/]([0-9a-f]{64})(?:\.scope)?(?:\n|$)/m,
    /(?:^|[/:])docker-([0-9a-f]{64})\.scope(?:\n|$)/m,
    /(?:^|[/:])cri-containerd-([0-9a-f]{64})\.scope(?:\n|$)/m,
    /(?:^|[/:])([0-9a-f]{64})(?:\n|$)/m,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function parseContainerIdFromMountInfo(text: string): string | undefined {
  const match = text.match(/\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)(?:\s|$)/);
  return match?.[1];
}

export async function ownContainerId(): Promise<string | undefined> {
  const cgroup = await readFile("/proc/self/cgroup", "utf8").catch(() => "");
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  return parseContainerIdFromCgroup(cgroup) ?? parseContainerIdFromMountInfo(mountInfo) ?? hostname();
}

const labelsSchema = Type.Record(Type.String(), Type.String());
const imageSchema = Type.Object({
  Id: Type.String(), RepoDigests: Type.Optional(Type.Array(Type.String())),
  Config: Type.Optional(Type.Object({ Labels: Type.Optional(Type.Union([labelsSchema, Type.Null()])) })),
});
export type DockerImage = Static<typeof imageSchema>;
export async function dockerImageInspect(reference: string, exec: DockerExec = dockerExec): Promise<DockerImage> {
  const result = await exec(["image", "inspect", reference]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Image is unavailable: ${reference}`);
  const image = Value.Parse(Type.Array(imageSchema), JSON.parse(result.stdout))[0];
  if (!image) throw new Error(`Docker returned no image: ${reference}`);
  return image;
}
export interface SelfUpdateRuntime { currentRevision?: string; currentDigest: string; }
/** Only System's managed app can ask its supervisor to replace it. */
export async function detectSelfUpdateRuntime(exec: DockerExec = dockerExec, containerId = ownContainerId): Promise<SelfUpdateRuntime | undefined> {
  const id = await containerId();
  if (!id) return undefined;
  const result = await exec(["inspect", id]);
  if (result.code !== 0) return undefined;
  const container = Value.Parse(Type.Array(Type.Object({ Image: Type.String(), Config: Type.Object({ Labels: Type.Optional(Type.Union([labelsSchema, Type.Null()])) }) })), JSON.parse(result.stdout))[0];
  if (container?.Config.Labels?.["agents-in-the-cloud.role"] !== "app") return undefined;
  const image = await dockerImageInspect(container.Image, exec);
  return { currentRevision: image.Config?.Labels?.["org.opencontainers.image.revision"], currentDigest: image.RepoDigests?.find((ref) => ref.startsWith("ghcr.io/") && ref.includes("@sha256:"))?.split("@")[1] ?? image.Id };
}
/** Docker preserves images referenced by any container, including stopped containers. */
export async function pruneUnusedAgentsInTheCloudImages(exec: DockerExec = dockerExec): Promise<void> {
  // Source alone also matches System and the shared Docker runtime. Only app
  // images carry both source and eagerly-preload; workspace images have a signature.
  const filters = [
    ["label=org.opencontainers.image.source=https://github.com/lucasmeijer/atelier", "label=eagerly-preload"],
    ["label=com.agents-in-the-cloud.workspace-image.signature"],
  ];
  for (const labels of filters) {
    const result = await exec(["image", "prune", "--all", "--force", ...labels.flatMap((label) => ["--filter", label])]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not prune unused AgentsInTheCloud images");
  }
}

export interface PreparedUpdate { imageId: string; reference: string; }
export async function prepareUpdate(reference: string, progress: (progress: PullProgress) => void, deps: {
  pull?: typeof pullImageReference; inspect?: typeof dockerImageInspect; resolve?: typeof resolveImage; exec?: DockerExec;
  prune?: typeof pruneUnusedAgentsInTheCloudImages;
} = {}): Promise<PreparedUpdate> {
  const pull = deps.pull ?? pullImageReference;
  const inspect = deps.inspect ?? dockerImageInspect;
  const resolve = deps.resolve ?? resolveImage;
  progress({ kind: "progress", message: "Preparing…" });
  const images = new Map<string, PlannedImage>();
  const aliases = new Map<string, string>();
  async function discover(requested: string): Promise<void> {
    if (aliases.has(requested)) return;
    const image = await resolve(requested);
    aliases.set(requested, image.reference);
    if (images.has(image.reference)) return;
    images.set(image.reference, image);
    for (const dependency of image.dependencies) await discover(dependency);
  }
  await discover(reference);
  progress({ kind: "progress", message: "Removing unused AgentsInTheCloud images…" });
  await (deps.prune ?? pruneUnusedAgentsInTheCloudImages)(deps.exec ?? dockerExec);
  const layers = new Map<string, { size: number; current: number }>();
  for (const image of images.values()) for (const layer of image.layers) layers.set(layer.digest, { size: layer.size, current: 0 });
  const total = [...layers.values()].reduce((sum, layer) => sum + layer.size, 0);
  function report(): void {
    const current = [...layers.values()].reduce((sum, layer) => sum + layer.current, 0);
    const percent = total ? Math.min(99, Math.floor(current / total * 100)) : 0;
    progress({ kind: "progress", percent, message: "Downloading…" });
  }
  report();
  for (const image of images.values()) {
    await pull(image.reference, (event) => {
      const matches = image.layers.filter((layer) => layer.digest.slice(7).startsWith(event.id));
      if (matches.length !== 1) return;
      const layer = layers.get(matches[0]!.digest)!;
      const downloaded = event.complete ? layer.size : Math.min(layer.size, event.current ?? 0);
      layer.current = Math.max(layer.current, downloaded);
      report();
    });
    for (const entry of image.layers) layers.get(entry.digest)!.current = entry.size;
    report();
  }
  progress({ kind: "progress", percent: 99, message: "Finalizing…" });
  const appReference = aliases.get(reference)!;
  const appImage = await inspect(appReference);
  for (const image of images.values()) {
    if (image.reference !== appReference) await inspect(image.reference);
  }
  // Keep declared mutable names usable by workspace creation, but only after all pulls succeed.
  for (const [alias, pinned] of aliases) {
    if (alias.includes("@")) continue;
    const result = await (deps.exec ?? dockerExec)(["image", "tag", pinned, alias]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not tag image: ${alias}`);
  }
  progress({ kind: "progress", percent: 100 });
  return { imageId: appImage.Id, reference };
}

export interface PullProgress {
  kind: "progress"; percent?: number; message?: string;
}

const dockerPullEventSchema = Type.Object({
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  progressDetail: Type.Optional(Type.Object({
    current: Type.Optional(Type.Number()),
  })),
  error: Type.Optional(Type.String()),
});

export interface PullLayerProgress { id: string; current?: number; complete: boolean }

export async function pullImageReference(reference: string, onProgress: (progress: PullLayerProgress) => void, socketPath = "/var/run/docker.sock"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, path: `/images/create?${new URLSearchParams({ fromImage: reference })}`, method: "POST" }, (res) => {
      let buffer = "";
      let errorBody = "";
      res.setEncoding("utf8");
      const emitLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const event = Value.Parse(dockerPullEventSchema, JSON.parse(trimmed));
        if (event.error) throw new Error(event.error);
        if (event.id) onProgress({
          id: event.id,
          current: event.status === "Downloading" ? event.progressDetail?.current : undefined,
          complete: event.status === "Download complete" || event.status === "Pull complete" || event.status === "Already exists",
        });
      };
      res.on("data", (chunk: string) => {
        if ((res.statusCode ?? 500) >= 400) {
          errorBody += chunk;
          return;
        }
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        try { for (const line of lines) emitLine(line); } catch (error) { req.destroy(); reject(error); }
      });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) reject(new Error(errorBody.trim() || `Docker image create failed with HTTP ${res.statusCode}`));
        else {
          try { emitLine(buffer); resolve(); } catch (error) { reject(error); }
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
