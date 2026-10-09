import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, createWorkspaceTemplateEnvironmentVariable, createWorkspaceTemplateSecret, listWorkspaceTemplates, revealWorkspaceTemplateSecrets, updateWorkspaceTemplate, updateWorkspaceTemplateSecret, getConfiguration } from "@agents-in-the-cloud/workspace-templates";

let directory: string;
let file: string;
let keyFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-workspace-template-transactions-"));
  file = join(directory, "projects.json");
  keyFile = join(directory, "workspace-template-secrets.key");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("concurrent project additions preserve every project", async () => {
  const added = await Promise.all(["one", "two", "three"].map((name) => addWorkspaceTemplate(`https://github.com/org/${name}.git`, file)));
  const stored = await listWorkspaceTemplates(file);
  expect(stored.workspaceTemplates.map((workspaceTemplate) => workspaceTemplate.id).sort()).toEqual(added.map(({ workspaceTemplate }) => workspaceTemplate.id).sort());
});

test("Workspace template, environment variable, and encrypted Secret mutations share one transaction", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/repo.git", file);
  await Promise.all([
    updateWorkspaceTemplate(workspaceTemplate.id, { name: "Renamed", spec: workspaceTemplate.gitUrl }, file),
    createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "API_URL", value: "https://example.com" }, file),
    createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "TOKEN_ONE", hostPattern: "example.com", secretValue: "one" }, file, keyFile),
    createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "TOKEN_TWO", hostPattern: "example.com", secretValue: "two" }, file, keyFile),
  ]);
  expect((await listWorkspaceTemplates(file)).workspaceTemplates[0].name).toBe("Renamed");
  expect((await getConfiguration(workspaceTemplate.id, file)).environment).toMatchObject([{ name: "API_URL", value: "https://example.com" }]);
  expect((await revealWorkspaceTemplateSecrets(workspaceTemplate.id, file, keyFile)).map((secret) => secret.secretValue).sort()).toEqual(["one", "two"]);
});

test("failed async mutations are not persisted and release the transaction", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/repo.git", file);
  const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "TOKEN", hostPattern: "example.com", secretValue: "original" }, file, keyFile);
  const invalidKeyFile = join(directory, "invalid.key");
  await writeFile(invalidKeyFile, "invalid");

  await expect(updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { envName: "CHANGED", hostPattern: "changed.example.com", secretValue: "changed" }, file, invalidKeyFile)).rejects.toThrow("template secrets key must be 32 bytes");
  await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "AFTER_FAILURE", value: "saved" }, file);

  expect(await revealWorkspaceTemplateSecrets(workspaceTemplate.id, file, keyFile)).toMatchObject([{ envName: "TOKEN", hostPattern: "example.com", secretValue: "original" }]);
  expect((await getConfiguration(workspaceTemplate.id, file)).environment).toMatchObject([{ name: "AFTER_FAILURE", value: "saved" }]);
});
