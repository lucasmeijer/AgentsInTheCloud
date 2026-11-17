import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const uninstallSocketPath = "/run/agents-in-the-cloud-system/uninstall.sock";
export type UninstallState = { state: "running" | "failed" | "complete"; description: string };
export type UninstallPlan = { token: string; workspaceCount: number };
type Docker = (...args: string[]) => Promise<string>;

export async function uninstallPlan(docker: Docker, dataDir = "/data/app"): Promise<UninstallPlan> {
  const labelled = await docker("ps", "-a", "--filter", "label=com.agents-in-the-cloud.type=workspace", "--format", '{{.ID}}\t{{.Label "com.agents-in-the-cloud.workspace-id"}}');
  const ids = new Set(labelled.split("\n").filter(Boolean).map(line => {
    const [containerId, workspaceId] = line.split("\t");
    return workspaceId?.trim() || containerId!.trim().slice(0, 8);
  }));
  try {
    for (const entry of await readdir(join(dataDir, "workspaces"), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.endsWith(".lock")) ids.add(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const token = createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
  return { token, workspaceCount: ids.size };
}

const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

export async function uninstallManagedResources(options: {
  token: string;
  docker: Docker;
  progress: (description: string) => Promise<void>;
  dataDir?: string;
}): Promise<void> {
  const { docker, progress, token, dataDir = "/data/app" } = options;
  await progress("Stopping the app and all workspace containers");
  const running = lines(await docker("ps", "-q"));
  if (running.length) await docker("stop", "--time", "20", ...running);
  if ((await uninstallPlan(docker, dataDir)).token !== token)
    throw new Error("Workspace inventory changed. Nothing has been deleted. Run --uninstall again to review the new count.");
  await progress("Deleting workspace and app containers");
  const containers = lines(await docker("ps", "-aq"));
  if (containers.length) await docker("rm", "--force", "--volumes", ...containers);
  await progress("Deleting workspace volumes and networks");
  const volumes = lines(await docker("volume", "ls", "-q"));
  if (volumes.length) await docker("volume", "rm", ...volumes);
  const networks = lines(await docker("network", "ls", "--filter", "type=custom", "-q"));
  if (networks.length) await docker("network", "rm", ...networks);
  await progress("Deleting managed images and build caches");
  await docker("builder", "prune", "--all", "--force");
  await docker("image", "prune", "--all", "--force");
  await progress("Deleting projects, settings, credentials, conversations, and shared files");
  await rm(dataDir, { recursive: true, force: true });
  await progress("Verifying managed resources are gone");
  if (lines(await docker("ps", "-aq")).length || lines(await docker("volume", "ls", "-q")).length ||
      lines(await docker("network", "ls", "--filter", "type=custom", "-q")).length ||
      lines(await docker("image", "ls", "-q")).length)
    throw new Error("Managed Docker resources remain. The installation volume has not been removed; run --uninstall again.");
}
