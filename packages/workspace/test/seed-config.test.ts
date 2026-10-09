import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, createWorkspaceTemplateSecret, createWorkspaceTemplateSshKey, listWorkspaceTemplates, revealWorkspaceTemplateSecrets, revealWorkspaceTemplateSshKeys, getConfiguration } from "@agents-in-the-cloud/workspace-templates";
import type { WorkspaceDockerPlan } from "../src/types.ts";
import { applySeedConfigManifest } from "../src/seed-config.ts";

let directory: string;
let host: string;
let nested: string;
let bin: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "workspace-seeded-config-"));
  host = join(directory, "host");
  nested = join(directory, "nested");
  bin = join(directory, "bin");
  await mkdir(host);
  await mkdir(bin);
  // Run the actual install script without requiring root or a local service user.
  await writeFile(join(bin, "su"), '#!/bin/sh\nexec /bin/sh -c "$5" "$6" "$7"\n');
  await writeFile(join(bin, "install"), '#!/bin/sh\ncp "$7" "$8"\nchmod 600 "$8"\n');
  await chmod(join(bin, "su"), 0o755);
  await chmod(join(bin, "install"), 0o755);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function emptyPlan(seedConfigEnabled?: boolean): WorkspaceDockerPlan {
  return { seedConfigEnabled, preloadImages: [], labels: {}, env: {}, mounts: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
}

function hostRuntime() {
  return { agentsInTheCloudDataDir: host, dockerHostAgentsInTheCloudDataDir: host, dockerBridgeHost: "127.0.0.1" };
}

async function seedPlan(workspaceTemplatesJson = join(nested, "projects.json")): Promise<WorkspaceDockerPlan> {
  const plan = emptyPlan(true);
  await applySeedConfigManifest({ version: 1, seedAgentsInTheCloudConfig: { projectsJson: workspaceTemplatesJson } }, plan, hostRuntime(), join(directory, "seed-config"));
  return plan;
}

async function installPlan(plan: WorkspaceDockerPlan): Promise<void> {
  const staging = join(directory, "staging");
  await mkdir(staging);
  for (const file of plan.containerFiles) await copyFile(file.source, file.target.replace("/.agents-in-the-cloud", staging));
  const script = plan.initScripts.join("\n").replaceAll("/.agents-in-the-cloud", staging);
  for (let boot = 0; boot < 2; boot++) {
    const process = Bun.spawn(["sh", "-eu", "-c", script], { env: { ...Bun.env, PATH: `${bin}:${Bun.env.PATH}` }, stderr: "pipe" });
    const stderr = await new Response(process.stderr).text();
    expect({ exitCode: await process.exited, stderr }).toEqual({ exitCode: 0, stderr: "" });
  }
}

test("catalogue seeding strips encrypted secrets and SSH keys before entering the workspace", async () => {
  const catalogue = join(host, "projects.json");
  const key = join(host, "project-secrets.key");
  const template = (await addWorkspaceTemplate("https://github.com/example/fixture.git", catalogue)).workspaceTemplate;
  await createWorkspaceTemplateSecret(template.id, { envName: "API_TOKEN", hostPattern: "api.example.com", secretValue: "fixture-token" }, catalogue, key);
  const privateKeyFile = join(directory, "id_ed25519");
  expect(await Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", privateKeyFile]).exited).toBe(0);
  const privateKey = await readFile(privateKeyFile, "utf8");
  await createWorkspaceTemplateSshKey(template.id, privateKey, catalogue, key);

  const originalCatalogue = await readFile(catalogue, "utf8");
  const originalKey = await readFile(key, "utf8");
  const plan = await seedPlan();
  expect(plan.containerFiles).toHaveLength(1);
  expect(plan.containerFiles[0]!.source).not.toBe(catalogue);
  const staged = await readFile(plan.containerFiles[0]!.source, "utf8");
  expect(staged).not.toContain("encryptedSecret");
  expect(staged).not.toContain("encryptedPrivateKey");
  expect(staged).not.toContain("sshKeys");
  expect(staged).not.toContain("fixture-token");
  expect(staged).not.toContain("OPENSSH PRIVATE KEY");
  expect(staged).not.toContain(originalKey.trim());
  const expectedCatalogue = JSON.parse(originalCatalogue);
  delete expectedCatalogue.projects[0].sshKeys;
  delete expectedCatalogue.projects[0].secrets[0].encryptedSecret;
  expect(JSON.parse(staged)).toEqual(expectedCatalogue);
  await installPlan(plan);
  const nestedCatalogue = join(nested, "projects.json");
  const nestedKey = join(nested, "project-secrets.key");
  expect(await Bun.file(nestedKey).exists()).toBe(false);
  expect((await listWorkspaceTemplates(nestedCatalogue)).workspaceTemplates[0]).toMatchObject({ id: template.id, gitUrl: template.gitUrl, name: template.name });
  expect((await getConfiguration(template.id, nestedCatalogue)).secrets).toMatchObject([{ envName: "API_TOKEN", hostPattern: "api.example.com", configured: false }]);
  expect(await revealWorkspaceTemplateSecrets(template.id, nestedCatalogue, nestedKey)).toEqual([]);
  expect(await revealWorkspaceTemplateSshKeys(template.id, nestedCatalogue, nestedKey)).toEqual([]);
  expect(await readFile(catalogue, "utf8")).toBe(originalCatalogue);
  expect(await readFile(key, "utf8")).toBe(originalKey);
  expect(await revealWorkspaceTemplateSecrets(template.id, catalogue, key)).toMatchObject([{ secretValue: "fixture-token" }]);
  expect(await revealWorkspaceTemplateSshKeys(template.id, catalogue, key)).toEqual([privateKey]);
});

test("a host with no encrypted values does not need an encryption key", async () => {
  await addWorkspaceTemplate("https://github.com/example/fixture.git", join(host, "projects.json"));
  const plan = await seedPlan();
  expect(plan.containerFiles).toHaveLength(1);
  await installPlan(plan);
  expect(await Bun.file(join(nested, "project-secrets.key")).exists()).toBe(false);
});

test("custom catalogue destinations still receive a sanitized copy", async () => {
  await addWorkspaceTemplate("https://github.com/example/fixture.git", join(host, "projects.json"));
  await writeFile(join(host, "project-secrets.key"), "fixture");
  const destination = join(nested, "custom", "catalogue.json");
  const plan = await seedPlan(destination);
  expect(plan.containerFiles).toHaveLength(1);
  expect(plan.initScripts[0]).toContain(destination);
  await installPlan(plan);
  expect(await Bun.file(destination).exists()).toBe(true);
  expect(await Bun.file(join(nested, "custom", "project-secrets.key")).exists()).toBe(false);
});

test("a manifest without catalogue seeding does not copy the host encryption key", async () => {
  await writeFile(join(host, "project-secrets.key"), "fixture");
  const plan = emptyPlan();
  await applySeedConfigManifest({ version: 1 }, plan, hostRuntime(), join(directory, "seed-config"));
  expect(plan.containerFiles).toEqual([]);
});

for (const enabled of [undefined, false]) {
  test(`seeding requires host authorization (${enabled}) before touching host files`, async () => {
    for (const requested of [
      { seedPiConfig: { authJson: "/nested/auth.json", modelsJson: "/nested/models.json", modelsStoreJson: "/nested/models-store.json" } },
      { seedAgentsInTheCloudConfig: { projectsJson: "/nested/projects.json" } },
    ]) {
      const plan = emptyPlan(enabled);
      await expect(applySeedConfigManifest({ version: 1, ...requested }, plan, hostRuntime(), join(directory, "seed-config"))).rejects.toMatchObject({ code: "workspace_seed_config_disabled" });
      expect(plan.containerFiles).toEqual([]);
      expect(plan.initScripts).toEqual([]);
      expect(await Bun.file(join(directory, "seed-config", "projects.json")).exists()).toBe(false);
    }
  });
}

test("authorized provider seeding copies the requested host files", async () => {
  await mkdir(join(host, "pi-config"));
  for (const name of ["auth.json", "models.json", "models-store.json"]) await writeFile(join(host, "pi-config", name), `fixture-${name}`);
  const plan = emptyPlan(true);
  await applySeedConfigManifest({ version: 1, seedPiConfig: { authJson: join(nested, "auth.json"), modelsJson: join(nested, "models.json"), modelsStoreJson: join(nested, "models-store.json") } }, plan, hostRuntime(), join(directory, "seed-config"));
  expect(plan.containerFiles).toHaveLength(3);
  await installPlan(plan);
  for (const name of ["auth.json", "models.json", "models-store.json"]) expect(await readFile(join(nested, name), "utf8")).toBe(`fixture-${name}`);
});
