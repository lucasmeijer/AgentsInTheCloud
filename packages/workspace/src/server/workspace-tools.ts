import { agentsInTheCloudDataPath, dockerHostAgentsInTheCloudDataPath, type AgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import { chmod, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceDockerMount } from "../types.ts";

export async function prepareWorkspaceToolsMount(
  runtime: AgentsInTheCloudRuntimeContext,
  packagesDirectory = fileURLToPath(new URL("../../../", import.meta.url)),
): Promise<WorkspaceDockerMount> {
  const directory = agentsInTheCloudDataPath(runtime, "workspace-tools");
  const tools = new Map<string, string>();
  const packages = await readdir(packagesDirectory, { withFileTypes: true });
  for (const entry of packages.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const packageDirectory = join(packagesDirectory, entry.name);
    const children = await readdir(packageDirectory, { withFileTypes: true });
    if (!children.some((child) => child.name === "workspace_tools" && child.isDirectory())) continue;
    const source = join(packageDirectory, "workspace_tools");
    for (const tool of await readdir(source, { withFileTypes: true })) {
      const origin = join(source, tool.name);
      if (!tool.isFile()) throw new Error(`Workspace tools must be regular files: ${origin}`);
      const existing = tools.get(tool.name);
      if (existing) throw new Error(`Conflicting workspace tool "${tool.name}": ${existing} and ${origin}`);
      tools.set(tool.name, origin);
    }
  }
  await mkdir(directory, { recursive: true });
  for (const [name, source] of tools) {
    const target = join(directory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  }
  for (const name of await readdir(directory)) {
    if (!tools.has(name)) await rm(join(directory, name));
  }
  return {
    type: "bind",
    source: dockerHostAgentsInTheCloudDataPath(runtime, "workspace-tools"),
    target: "/opt/agents-in-the-cloud/bin",
    readonly: true,
  };
}
