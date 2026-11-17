import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocker, runCommand, workloadCgroupArgs } from "@agents-in-the-cloud/core";
import { reuseDefaultWorkspaceImage, type DockerCommand } from "./local-images.ts";
import { parseWorkspaceImageMetadata, type WorkspaceImageMetadata } from "./metadata.ts";

export interface DefaultWorkspaceImageContext {
  contextDir: string;
  dockerfile: string;
  metadata: WorkspaceImageMetadata;
  dispose(): Promise<void>;
}

export interface EnsureDefaultImageOptions {
  docker?: DockerCommand;
  force?: boolean;
  imageName?: (contentTag: string) => string;
  exists?: (image: string) => Promise<boolean>;
  build?: (context: DefaultWorkspaceImageContext, image: string) => Promise<void>;
  context?: DefaultWorkspaceImageContext;
}

const root = join(import.meta.dir, "../../..");

export async function prepareDefaultWorkspaceImage(sourceRoot = root): Promise<DefaultWorkspaceImageContext> {
  const contextDir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-workspace-image-"));
  const dispose = () => rm(contextDir, { recursive: true, force: true });
  try {
    const { exitCode: code, stdout, stderr } = await runCommand(["bun", join(sourceRoot, "packages/workspace-image/scripts/build-context.mjs"), contextDir], { cwd: sourceRoot });
    if (code !== 0) throw new Error(`Could not generate workspace image: ${stderr || stdout}`);
    const metadata = parseWorkspaceImageMetadata(JSON.parse(await readFile(join(contextDir, "metadata.json"), "utf8")));
    return { contextDir, dockerfile: join(contextDir, "Dockerfile"), metadata, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Resolve the signature in the selected image store, building only on a miss.
 * Publishers supply their own registry-tag existence check. */
export async function ensureGeneratedDefaultWorkspaceImage(options: EnsureDefaultImageOptions = {}): Promise<string> {
  const context = options.context ?? await prepareDefaultWorkspaceImage();
  const docker = options.docker ?? runDocker;
  const image = options.imageName?.(context.metadata.tag) ?? context.metadata.tag;
  try {
    if (!options.force && await (options.exists ? options.exists(image) : reuseDefaultWorkspaceImage(image, docker))) return image;
    if (options.build) await options.build(context, image);
    else {
      const result = await docker(["build", ...await workloadCgroupArgs(), "--progress=plain", "--label", "com.agents-in-the-cloud.workspace-image.kind=default", "-t", image, "-f", context.dockerfile, context.contextDir]);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `Could not build ${image}`);
    }
    return image;
  } finally {
    if (!options.context) await context.dispose();
  }
}
