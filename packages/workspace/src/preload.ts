import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError, requireDocker, workloadCommand, runCommand, waitForCommand, withCommandSignal, shellQuote, writeFileAtomic } from "@agents-in-the-cloud/core";
import { ensureDefaultWorkspaceImage } from "@agents-in-the-cloud/workspace-image";

import { runHostObservableCommand, stripTerminalControls, tailTerminalText } from "@agents-in-the-cloud/observable-terminal/server";
import type { WorkspaceProvisionProgress } from "./provisioning.ts";
import { requireRootInWorkspace } from "./helper.ts";

type Report = (progress: WorkspaceProvisionProgress) => void;
interface CachePreparation {
  task: Promise<void>;
  progress: WorkspaceProvisionProgress;
  listeners: Set<Report>;
}
async function buildCacheCommand(args: string[], report: Report) {
  const result = await runHostObservableCommand({
    session: `agents-in-the-cloud-provision-image-cache-${crypto.randomUUID().slice(0, 12)}`,
    cwd: "/",
    command: args.map(shellQuote).join(" "),
    onSessionStarted: (terminalSession) => report({ terminalSession, output: undefined }),
  });
  const output = tailTerminalText(stripTerminalControls(result.output));
  report({ terminalSession: undefined, output });
  if (result.exitCode !== 0) throw new Error(output || `Image cache preparation failed with exit code ${result.exitCode}`);
}

export const defaultWorkspacePreload = "agents-in-the-cloud:default-workspace";

export interface PreparedImage { requested: string; reference?: string }
type Command = (args: string[]) => Promise<{ stdout: Buffer; stderr: string }>;
async function command(args: string[]) {
  const { stdout, stderr, exitCode } = await runCommand(args);
  if (exitCode !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${stderr.trim()}`);
  return { stdout, stderr };
}

export function normalizeImageReference(input: string): string {
  if (!input || /\s|["'\\]/.test(input)) throw new Error(`Invalid image reference: ${input}`);
  let name = input;
  const first = name.split("/")[0]!;
  if (!name.includes("/") || !(first.includes(".") || first.includes(":") || first === "localhost")) name = `docker.io/${name}`;
  if (name.startsWith("docker.io/") && !name.slice(10).includes("/")) name = `docker.io/library/${name.slice(10)}`;
  if (!name.includes("@") && !name.slice(name.lastIndexOf("/") + 1).includes(":")) name += ":latest";
  return name;
}

/** One app owns the shared directory. Image prep is deduplicated; mkfs commands
 * serialize so different manifests sharing a layer cannot replace each other's files. */
export function createImagePreloader(run: Command = command, docker: typeof requireDocker = requireDocker, cacheDirectory = "/data/erofs-cache", defaultWorkspace: () => Promise<string> = ensureDefaultWorkspaceImage, build: (args: string[], report: Report) => Promise<void> = buildCacheCommand, inWorkspace: typeof requireRootInWorkspace = requireRootInWorkspace) {
  const resolving = new Map<string, Promise<string>>();
  const preparing = new Map<string, CachePreparation>();
  let cacheQueue = Promise.resolve();
  const ctr = (...args: string[]) => run(["ctr", "--namespace", "moby", ...args]);
  async function resolve(requested: string): Promise<string> {
    const name = normalizeImageReference(requested);
    let task = resolving.get(name);
    if (!task) {
      task = withCommandSignal(AbortSignal.timeout(5 * 60_000), async () => {
        let listing = await ctr("images", "ls", `name==${name}`);
        if (!listing.stdout.toString().split("\n").some((row) => row.split(/\s+/)[0] === name)) {
          await ctr("content", "fetch", name);
          listing = await ctr("images", "ls", `name==${name}`);
        }
        const row = listing.stdout.toString().split("\n").find((row) => row.split(/\s+/)[0] === name);
        const digest = row?.split(/\s+/)[2];
        if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`containerd did not resolve ${name}`);
        const reference = `${name.split("@")[0]}@${digest}`;
        await ctr("images", "tag", "--force", name, reference);
        return reference;
      }).finally(() => resolving.delete(name));
      resolving.set(name, task);
    }
    return waitForCommand(task);
  }
  async function prepare(reference: string, report: Report): Promise<void> {
    let entry = preparing.get(reference);
    if (!entry) {
      const state: CachePreparation = { task: Promise.resolve(), progress: { detail: "Waiting for image cache preparation queue" }, listeners: new Set<Report>() };
      const publish: Report = (progress) => {
        Object.assign(state.progress, progress);
        for (const listener of state.listeners) listener(progress);
      };
      state.task = cacheQueue.then(() => withCommandSignal(AbortSignal.timeout(5 * 60_000), async () => {
        publish({ detail: "Checking cached image layers" });
        const image = await docker(["image", "inspect", reference, "--format", "{{json .RootFS.Layers}}"]);
        const diffIDs: string[] = JSON.parse(image.stdout) ?? [];
        // Avoid launching ctr at all when every layer is already cached.
        const present = await Promise.all(diffIDs.map(async (diffID) => {
          const match = /^sha256:([a-f0-9]{64})$/.exec(diffID);
          if (!match) throw new Error(`Unsupported image layer digest: ${diffID}`);
          const hash = match[1]!;
          try {
            const file = await stat(join(cacheDirectory, "sha256", hash.slice(0, 2), `${hash}.erofs`));
            if (!file.isFile() || file.size < 4096) throw new Error(`Invalid cached EROFS layer: ${diffID}`);
            return true;
          } catch (error) {
            if (isNotFoundError(error)) return false;
            throw error;
          }
        }));
        if (present.every(Boolean)) {
          publish({ detail: `Reusing all ${diffIDs.length} cached layers` });
          return;
        }
        publish({ detail: `Preparing image cache: ${present.filter(Boolean).length}/${diffIDs.length} layers cached`, output: undefined });
        await build(await workloadCommand(["ctr", "--namespace", "moby", "images", "build-erofs-cache", reference, cacheDirectory]), publish);
      }));
      cacheQueue = state.task.then(() => {}, () => {});
      entry = state;
      preparing.set(reference, entry);
      state.task.catch(() => preparing.delete(reference));
    }
    report(entry.progress);
    entry.listeners.add(report);
    try { await waitForCommand(entry.task); }
    finally { entry.listeners.delete(report); }
  }
  return {
    async snapshot(images: string[], directory: string): Promise<string | undefined> {
      await mkdir(directory, { recursive: true });
      const prepared: PreparedImage[] = [...new Set(images)].map((requested) => ({ requested }));
      const workspace = prepared.find((image) => image.requested === defaultWorkspacePreload);
      let referenceFile: string | undefined;
      if (workspace) {
        workspace.reference = await resolve(await defaultWorkspace());
        await mkdir(join(directory, "agents-in-the-cloud"), { recursive: true });
        referenceFile = join(directory, "agents-in-the-cloud", "default-workspace-image");
        await writeFile(referenceFile, `${workspace.reference}\n`);
      }
      await writeFile(join(directory, "preloads.json"), JSON.stringify(prepared));
      return referenceFile;
    },
    async load(directory: string, report: (detail: string) => void = () => {}): Promise<PreparedImage[]> {
      const images: PreparedImage[] = JSON.parse(await readFile(join(directory, "preloads.json"), "utf8"));
      for (const image of images) {
        if (image.reference) continue;
        report(`Resolving image ${image.requested}`);
        image.reference = await resolve(image.requested);
        await writeFileAtomic(join(directory, "preloads.json"), JSON.stringify(images));
      }
      return images;
    },
    async install(images: PreparedImage[], workspaceId: string, report: (detail: string) => void = () => {}, activity: Report = () => {}): Promise<void> {
      if (!images.length) return;
      // containerd is sufficient for importing snapshots; socket activation keeps Docker asleep.
      report("Starting workspace containerd");
      await inWorkspace(workspaceId, ["systemctl", "start", "containerd.service"]);
      for (const image of images) {
        if (!image.reference) throw new Error(`Image has not been resolved: ${image.requested}`);
        await prepare(image.reference, (progress) => {
          if (progress.detail) report(`${image.requested}: ${progress.detail}`);
          const { detail: _detail, ...visualization } = progress;
          activity(visualization);
        });
        activity({ output: undefined, terminalSession: undefined });
        report(`Exporting image ${image.requested}`);
        const archive = await run(["agents-in-the-cloud-image-transfer", "export", image.reference]);
        report(`Importing image ${image.requested} into workspace`);
        const imported = await inWorkspace(workspaceId, ["agents-in-the-cloud-image-transfer", "import"], archive.stdout);
        if (image.requested === defaultWorkspacePreload) {
          // Transfer selects the native manifest from a multi-platform index.
          // FROM must name that installed manifest, not the source index digest.
          const reference = imported.trim();
          if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(reference)) throw new Error("Image transfer did not return an installed image reference");
          await inWorkspace(workspaceId, ["tee", "/etc/agents-in-the-cloud/default-workspace-image"], `${reference}\n`);
        }
      }
    },
  };
}
export const workspaceImagePreloader = createImagePreloader();
