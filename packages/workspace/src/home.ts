import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { agentsInTheCloudDataPath, createProcessFileLock, dockerHostAgentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, requireDocker } from "@agents-in-the-cloud/core";
import { ensureDefaultWorkspaceImage } from "@agents-in-the-cloud/workspace-image";
import type { WorkspaceDockerMount } from "./types.ts";

const withHomeLock = createProcessFileLock({
  lockDir: () => agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "home.lock"),
  label: "shared home initialization",
});

export async function ensureSharedHome(): Promise<void> {
  const runtime = getAgentsInTheCloudRuntimeContext();
  const home = agentsInTheCloudDataPath(runtime, "home");
  if (existsSync(home)) return;
  const image = await ensureDefaultWorkspaceImage();
  await withHomeLock(async () => {
    if (existsSync(home)) return;
    const staging = await mkdtemp(agentsInTheCloudDataPath(runtime, ".home-seed-"));
    const container = `agents-in-the-cloud-home-seed-${crypto.randomUUID()}`;
    try {
      await requireDocker(["create", "--name", container, "--entrypoint", "/bin/true", image]);
      try {
        await requireDocker(["cp", `${container}:/opt/agents-in-the-cloud/home-defaults/.`, staging]);
      } finally {
        await requireDocker(["rm", container]);
      }
      await chmod(staging, 0o700);
      await rename(staging, home);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

export async function workspaceHomeMounts(workspaceId: string): Promise<WorkspaceDockerMount[]> {
  await ensureSharedHome();
  const runtime = getAgentsInTheCloudRuntimeContext();
  const mounts: WorkspaceDockerMount[] = [{ type: "bind", source: dockerHostAgentsInTheCloudDataPath(runtime, "home"), target: "/home/agents-in-the-cloud" }];
  for (const path of [".local/share", ".local/state", ".cache"]) {
    await mkdir(agentsInTheCloudDataPath(runtime, "home", path), { recursive: true });
    await mkdir(agentsInTheCloudDataPath(runtime, "workspaces", workspaceId, "home-local", path), { recursive: true, mode: 0o700 });
    mounts.push({ type: "bind", source: dockerHostAgentsInTheCloudDataPath(runtime, "workspaces", workspaceId, "home-local", path), target: `/home/agents-in-the-cloud/${path}` });
  }
  return mounts;
}
