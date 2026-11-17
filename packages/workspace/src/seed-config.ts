import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, type AgentsInTheCloudRuntimeContext, type JsonObject } from "@agents-in-the-cloud/core";
import type { RepoWorkspaceManifest } from "./index.ts";
import type { WorkspaceDockerPlan } from "./types.ts";
import { seedConfigInstallScript } from "./startup-scripts.ts";

let seededPiAuth: ((auth: JsonObject) => JsonObject) | undefined;

export function registerSeededPiAuth(transform: (auth: JsonObject) => JsonObject): void {
  seededPiAuth = transform;
}

export async function applySeedConfigManifest(manifest: RepoWorkspaceManifest, plan: WorkspaceDockerPlan, runtime: AgentsInTheCloudRuntimeContext, seedDirectory: string): Promise<void> {
  if ((manifest.seedPiConfig || manifest.seedAgentsInTheCloudConfig) && !plan.seedConfigEnabled) {
    throw new AgentsInTheCloudCoreError("workspace_seed_config_disabled", "This repository requests Atelier-in-Atelier seeding. Enable it in the workspace template’s Developer Settings (hold Alt in template settings), then create a new workspace.");
  }
  const entries: Array<{ source: string; staging: string; target: string }> = [];
  const authJson = manifest.seedPiConfig?.authJson;
  if (authJson) {
    if (!seededPiAuth) throw new Error("Pi auth seeding is not registered");
    const auth = seededPiAuth(JSON.parse(await readFile(agentsInTheCloudDataPath(runtime, "pi-config", "auth.json"), "utf8")));
    entries.push({ source: await writeSeedFile(seedDirectory, "auth.json", JSON.stringify(auth)), staging: "/.agents-in-the-cloud/seed-pi-auth.json", target: authJson });
  }
  for (const [name, target] of [
    ["models", manifest.seedPiConfig?.modelsJson],
    ["models-store", manifest.seedPiConfig?.modelsStoreJson],
  ] as const) {
    if (target) entries.push({ source: agentsInTheCloudDataPath(runtime, "pi-config", `${name}.json`), staging: `/.agents-in-the-cloud/seed-pi-${name}.json`, target });
  }
  const workspaceTemplatesJson = manifest.seedAgentsInTheCloudConfig?.projectsJson;
  if (workspaceTemplatesJson) {
    // Sanitize on the host: neither encrypted credentials nor the master key may
    // cross into the agent workspace, even as temporary staging files.
    const catalogue = JSON.parse(await readFile(agentsInTheCloudDataPath(runtime, "projects.json"), "utf8"));
    const sanitized = JSON.stringify(catalogue, (key, value) =>
      key === "encryptedSecret" || key === "encryptedPrivateKey" || key === "sshKeys" ? undefined : value,
    );
    entries.push({ source: await writeSeedFile(seedDirectory, "projects.json", sanitized), staging: "/.agents-in-the-cloud/seed-projects.json", target: workspaceTemplatesJson });
  }
  for (const entry of entries) {
    plan.containerFiles.push({ source: entry.source, target: entry.staging });
    plan.initScripts.push(seedConfigInstallScript(entry.staging, entry.target));
  }
}

async function writeSeedFile(seedDirectory: string, name: string, json: string): Promise<string> {
  await mkdir(seedDirectory, { recursive: true });
  const path = join(seedDirectory, name);
  await writeFile(path, `${json}\n`, { mode: 0o600 });
  return path;
}
