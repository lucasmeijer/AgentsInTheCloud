import { afterEach, beforeEach, expect, test } from "bun:test";
import { addWorkspaceTemplate, createWorkspaceTemplateSecret, revealWorkspaceTemplateSecrets, getConfiguration } from "@agents-in-the-cloud/workspace-templates";
import { createTestApp, postJson, temporaryAgentsInTheCloudDataDir } from "./support/test-web-app.ts";

const data = temporaryAgentsInTheCloudDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

test("secret API accepts boolean path permission and preserves omission", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/example/permissions.git");
  const { app } = createTestApp();
  const values = { envName: "TOKEN", hostPattern: "api.example.com" };
  const response = await app.fetch(postJson(`/workspace-templates/${workspaceTemplate.id}/secrets`, { ...values, allowInPath: true }));
  expect(response.status).toBe(200);
  const { secret } = await response.json();
  expect(secret.allowInPath).toBe(true);
  const path = `/workspace-templates/${workspaceTemplate.id}/secrets/${secret.id}`;
  expect((await (await app.fetch(postJson(path, values))).json()).secret.allowInPath).toBe(true);
  expect((await (await app.fetch(postJson(path, { ...values, allowInPath: false }))).json()).secret.allowInPath).toBe(false);
  for (const allowInPath of ["true", "auto", null, 1, {}]) {
    expect((await app.fetch(postJson(path, { ...values, allowInPath }))).status).toBe(400);
  }
  expect((await getConfiguration(workspaceTemplate.id)).secrets[0]?.allowInPath).toBe(false);
});

test("form path permission persists and rejects invalid values", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/example/permissions.git");
  const values = { envName: "TOKEN", hostPattern: "api.example.com" };
  const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, values);
  const { app } = createTestApp();
  const path = `/workspace-templates/${workspaceTemplate.id}/secrets/${secret.id}`;
  const form = (allowInPath: string) => new Request(`http://test.local${path}`, { method: "POST", headers: { accept: "text/vnd.turbo-stream.html" }, body: new URLSearchParams({ ...values, allowInPath }) });
  expect((await app.fetch(form("true"))).status).toBe(200);
  expect((await getConfiguration(workspaceTemplate.id)).secrets[0]?.allowInPath).toBe(true);
  expect(await revealWorkspaceTemplateSecrets(workspaceTemplate.id)).toEqual([]);
  expect((await app.fetch(form("false"))).status).toBe(200);
  expect((await getConfiguration(workspaceTemplate.id)).secrets[0]?.allowInPath).toBe(false);
  expect((await app.fetch(form("invalid"))).status).toBe(422);
  expect((await app.fetch(form(""))).status).toBe(422);
});

test("secret forms persist the displayed boolean choice even for known path-based APIs", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/example/default-permissions.git");
  const { app } = createTestApp();
  for (const [envName, hostPattern, allowInPath] of [
    ["BOT_TOKEN", "api.telegram.org", "true"],
    ["API_TOKEN", "api.example.com", "false"],
    ["DISABLED_BOT", "api.telegram.org", "false"],
  ] as const) {
    const response = await app.fetch(new Request(`http://test.local/workspace-templates/${workspaceTemplate.id}/secrets`, {
      method: "POST", headers: { accept: "text/vnd.turbo-stream.html" },
      body: new URLSearchParams({ envName, hostPattern, allowInPath, secretValue: "test-only-value" }),
    }));
    expect(response.status).toBe(200);
  }
  expect((await getConfiguration(workspaceTemplate.id)).secrets.map(({ envName, allowInPath }) => ({ envName, allowInPath }))).toEqual([
    { envName: "API_TOKEN", allowInPath: false },
    { envName: "BOT_TOKEN", allowInPath: true },
    { envName: "DISABLED_BOT", allowInPath: false },
  ]);
});
