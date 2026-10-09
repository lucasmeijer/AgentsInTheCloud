import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, createWorkspaceTemplateEnvironmentVariable, createWorkspaceTemplateSecret, createWorkspaceTemplateSshKey, effectiveEnvironment, getConfiguration, globalWorkspaceConfiguration, listWorkspaceTemplates, revealEffectiveSecrets, revealEffectiveSshKeys } from "@agents-in-the-cloud/workspace-templates";

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-global-configuration-"));
  return { dir, file: join(dir, "projects.json"), keyFile: join(dir, "key") };
}

describe("Global workspace settings", () => {
  test("load files saved before global settings existed", async () => {
    const { file } = await store();
    await writeFile(file, JSON.stringify({ projects: [] }));
    expect(await getConfiguration(globalWorkspaceConfiguration, file)).toEqual({ environment: [], secrets: [], sshKeys: [], sshKnownHosts: "" });
  });

  test("a template's own secret replaces a global secret with the same name", async () => {
    const { file, keyFile } = await store();
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git", file)).workspaceTemplate;
    const global = await createWorkspaceTemplateSecret(globalWorkspaceConfiguration, { envName: "NPM_TOKEN", hostPattern: "registry.npmjs.org", secretValue: "global-token" }, file, keyFile);
    await createWorkspaceTemplateSecret(globalWorkspaceConfiguration, { envName: "OPENAI_API_KEY", hostPattern: "api.openai.com", secretValue: "openai" }, file, keyFile);
    await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "NPM_TOKEN", hostPattern: "npm.pkg.github.com", secretValue: "template-token" }, file, keyFile);

    expect(global).not.toHaveProperty("workspaceTemplateId");
    expect(JSON.parse(await readFile(file, "utf8")).global.secrets[0].encryptedSecret).not.toContain("global-token");
    expect((await revealEffectiveSecrets(workspaceTemplate.id, file, keyFile)).map(({ envName, secretValue }) => ({ envName, secretValue })).sort((a, b) => a.envName.localeCompare(b.envName))).toEqual([
      { envName: "NPM_TOKEN", secretValue: "template-token" },
      { envName: "OPENAI_API_KEY", secretValue: "openai" },
    ]);
    // Empty workspaces have no template, so only global secrets apply.
    expect((await revealEffectiveSecrets(undefined, file, keyFile)).map(({ secretValue }) => secretValue).sort()).toEqual(["global-token", "openai"]);
  });

  test("a template's own variable replaces a global variable with the same name", async () => {
    const { file } = await store();
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git", file)).workspaceTemplate;
    await createWorkspaceTemplateEnvironmentVariable(globalWorkspaceConfiguration, { name: "TZ", value: "Europe/Amsterdam" }, file);
    await createWorkspaceTemplateEnvironmentVariable(globalWorkspaceConfiguration, { name: "REGISTRY", value: "global" }, file);
    await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "REGISTRY", value: "template" }, file);

    expect(await effectiveEnvironment(workspaceTemplate.id, file)).toEqual({ TZ: "Europe/Amsterdam", REGISTRY: "template" });
    expect(await effectiveEnvironment(undefined, file)).toEqual({ TZ: "Europe/Amsterdam", REGISTRY: "global" });
  });

  test("workspaces receive global SSH keys as well as their template's", async () => {
    const { dir, file, keyFile } = await store();
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git", file)).workspaceTemplate;
    const keys = await Promise.all(["global", "template"].map(async (name) => {
      const path = join(dir, name);
      expect(await Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path]).exited).toBe(0);
      return await readFile(path, "utf8");
    }));
    await createWorkspaceTemplateSshKey(globalWorkspaceConfiguration, keys[0]!, file, keyFile);
    await createWorkspaceTemplateSshKey(workspaceTemplate.id, keys[1]!, file, keyFile);

    expect(await revealEffectiveSshKeys(workspaceTemplate.id, file, keyFile)).toEqual(keys);
    expect(await revealEffectiveSshKeys(undefined, file, keyFile)).toEqual([keys[0]!]);
  });

  test("template fingerprints change only once global settings have content", async () => {
    const { file } = await store();
    await addWorkspaceTemplate("https://github.com/org/repo.git", file);
    const before = (await listWorkspaceTemplates(file)).workspaceTemplates[0]!.configurationFingerprint;
    await writeFile(file, JSON.stringify({ projects: JSON.parse(await readFile(file, "utf8")).projects }));
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.configurationFingerprint).toBe(before);

    await createWorkspaceTemplateEnvironmentVariable(globalWorkspaceConfiguration, { name: "TZ", value: "UTC" }, file);
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.configurationFingerprint).not.toBe(before);
  });
});
