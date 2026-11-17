import { workspaceWarnings } from "../src/server/workspace-warnings.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  addWorkspaceTemplate,
  createWorkspaceTemplateEnvironmentVariable,
  getWorkspaceTemplateConfiguration,
  getStoredCommitIdentity,
  isGitWorkspaceTemplateInit,
  listWorkspaceTemplates,
  workspaceInitFromTemplate,
  revealWorkspaceTemplateSecrets,
} from "@agents-in-the-cloud/workspace-templates";
import {
  createTestApp,
  deferred,
  postJson,
  postForm,
  temporaryAgentsInTheCloudDataDir,
  type ProvisionWorkspaceOptions,
} from "./support/test-web-app.ts";

const workspaceCreatedResponseSchema = Type.Object({
  workspace: Type.Object({ id: Type.String(), url: Type.String(), phase: Type.Object({ kind: Type.Literal("provisioningPhase"), busy: Type.Boolean() }) }),
});
const workspaceStatusResponseSchema = Type.Object({
  workspace: Type.Object({ title: Type.String(), phase: Type.Object({ kind: Type.String(), busy: Type.Boolean() }), url: Type.String() }),
});
const workspaceTemplateSummarySchema = Type.Object({ id: Type.String(), name: Type.String() });
const workspaceTemplateResponseSchema = Type.Object({ workspaceTemplate: workspaceTemplateSummarySchema });
const workspaceTemplateListResponseSchema = Type.Object({ workspaceTemplates: Type.Array(workspaceTemplateSummarySchema) });
const environmentVariableSchema = Type.Object({ id: Type.String(), name: Type.String(), value: Type.String() });
const environmentVariableResponseSchema = Type.Object({ environmentVariable: environmentVariableSchema });
const deletedWorkspaceTemplateEnvironmentVariableResponseSchema = Type.Object({
  deleted: Type.Literal(true),
  environmentVariable: environmentVariableSchema,
}, { additionalProperties: false });
const workspaceTemplateSecretSummarySchema = Type.Object({
  id: Type.String(),
  workspaceTemplateId: Type.String(),
  envName: Type.String(),
  hostPattern: Type.String(),
  allowInPath: Type.Boolean(),
  placeholder: Type.Optional(Type.String()),
  annotation: Type.String(),
  configured: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
}, { additionalProperties: false });
const workspaceTemplateSecretResponseSchema = Type.Object({ secret: workspaceTemplateSecretSummarySchema }, { additionalProperties: false });
const deletedWorkspaceTemplateSecretResponseSchema = Type.Object({
  deleted: Type.Literal(true),
  secret: workspaceTemplateSecretSummarySchema,
}, { additionalProperties: false });
const workspaceTemplateDetailResponseSchema = Type.Object({
  workspaceTemplate: Type.Object({
    id: Type.String(),
    name: Type.String(),
    gitUrl: Type.String(),
    branch: Type.Union([Type.String(), Type.Null()]),
    sessionShareKey: Type.String(),
    createdAt: Type.Optional(Type.Number()),
    lastUsedAt: Type.Optional(Type.Number()),
    configurationFingerprint: Type.String(),
    preloadImages: Type.Array(Type.String()),
    privileged: Type.Boolean(),
    seedConfigEnabled: Type.Boolean(),
    environment: Type.Array(environmentVariableSchema),
    secrets: Type.Array(workspaceTemplateSecretSummarySchema),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const workspaceTemplateDeletionBlockedResponseSchema = Type.Object({
  deleted: Type.Literal(false),
  blocked: Type.Literal(true),
  references: Type.Array(Type.Object({ workspaceId: Type.String(), title: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
const dataDir = temporaryAgentsInTheCloudDataDir();
beforeEach(dataDir.setUp);
afterEach(dataDir.tearDown);

describe("HTTP contracts", () => {
  test("Commit identity saves through canonical and existing POST URLs", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);
    for (const path of ["/settings/commit-identity", "/settings/git-identity"]) {
      const author = path.endsWith("/commit-identity") ? "Ada Lovelace" : "Grace Hopper";
      const response = await app.fetch(postForm(path, new URLSearchParams({ commitAuthorName: author, commitAuthorEmail: "author@example.com" })));
      expect(response.status).toBe(200);
      expect(await getStoredCommitIdentity()).toEqual({ name: author, email: "author@example.com" });
    }
  });

  test("retired agent onboarding endpoints are unavailable and cannot create workspaces", async () => {
    const { app, registry } = createTestApp();
    const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/example/no-agent-setup.git");
    for (const path of [`/workspace-templates/${workspaceTemplate.id}/onboarding`, `/workspace-templates/${workspaceTemplate.id}/secrets/unused/value`]) {
      expect((await app.fetch(new Request(`http://test.local${path}`, { headers: { accept: "application/json" } }))).status).toBe(404);
      expect((await app.fetch(postJson(path, {}))).status).toBe(404);
    }
    expect(registry.list()).toEqual([]);
  });

  test("restart requests from both surfaces reach the update module", async () => {
    const { app } = createTestApp();
    for (const surface of ["sidebar", "settings"]) {
      const result = await app.fetch(new Request(`http://test.local/update/restart?surface=${surface}`, { method: "POST" }));
      expect(result.status).toBe(409);
      expect(await result.text()).toBe("Updates require AgentsInTheCloud System");
    }
  });

  test("HEAD / and /up match their GET status without a body", async () => {
    const { app } = createTestApp();
    const home = await app.fetch(new Request("http://test.local/", { method: "HEAD" }));
    const up = await app.fetch(new Request("http://test.local/up", { method: "HEAD" }));

    expect(home.status).toBe(200);
    expect(await home.text()).toBe("");
    expect(up.status).toBe(200);
    expect(await up.text()).toBe("");
  });

  test("creates a workspace asynchronously and reports its phase through JSON", async () => {
    const provision = deferred();
    const seen: Array<{ id: string; options: unknown }> = [];
    const { app, registry } = createTestApp({
      provision: (id, options) => {
        seen.push({ id, options });
        return provision.promise;
      },
    });
    await registry.seed([]);

    const response = await app.fetch(postJson("/workspaces", { title: "Evaluation" }));
    const body = Value.Parse(workspaceCreatedResponseSchema, await response.json());
    const status = await app.fetch(new Request(`http://test.local/workspaces/${body.workspace.id}`, {
      headers: { accept: "application/json" },
    }));
    const statusBody = Value.Parse(workspaceStatusResponseSchema, await status.json());

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("location")).toBe(body.workspace.url);
    expect(body.workspace.url).toBe(`/workspaces/${body.workspace.id}`);
    expect(statusBody.workspace.url).toBe(body.workspace.url);
    expect(new URL(body.workspace.url, "https://demoagents-in-the-cloud-arm.tail67e2f4.ts.net/workspaces").protocol).toBe("https:");
    expect(statusBody.workspace).toMatchObject({ title: "Evaluation", phase: { kind: "provisioningPhase" } });
    expect(registry.get(body.workspace.id)?.init).toBeUndefined();
    expect(seen[0]?.id).toBe(body.workspace.id);

    provision.resolve();
  });

  test("creates a project workspace with agent context through JSON", async () => {
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/sample-project.git#main")).workspaceTemplate;
    const seen: Array<{ id: string; options: ProvisionWorkspaceOptions }> = [];
    const { app, registry } = createTestApp({ provision: async (id, options) => { seen.push({ id, options }); } });
    await registry.seed([]);

    const refused = await app.fetch(postJson("/workspaces", {
      source: { type: "workspace-template", workspaceTemplate: "sample-project" },
      agent: { initialPrompt: "Add tests", model: "openai::gpt", thinkingLevel: "medium" },
    }));
    expect(refused.status).toBe(400);
    expect(registry.list()).toHaveLength(0);

    const response = await app.fetch(postJson("/workspaces", {
      source: { type: "workspace-template", workspaceTemplate: "sample-project" },
      agent: { initialPrompt: "Add tests" },
    }));
    const body = Value.Parse(workspaceCreatedResponseSchema, await response.json());
    const entry = registry.get(body.workspace.id)!;

    expect(response.status).toBe(202);
    expect(isGitWorkspaceTemplateInit(entry.init)).toBe(true);
    expect(isGitWorkspaceTemplateInit(entry.init) && entry.init).toMatchObject({
      projectId: workspaceTemplate.id,
      name: "sample-project",
      gitUrl: "https://github.com/org/sample-project.git",
      branch: "main",
    });
    expect(seen[0]?.options?.context).toEqual({
      agent: { agentTypeId: "builtin", initialPrompt: "Add tests", initialPromptMode: "composer", model: "", thinkingLevel: "", attachmentDraft: undefined },
    });
  });

  test("workspace template JSON CRUD never exposes secret values", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);
    const specification = "https://github.com/org/json-project.git#main";

    const createdResponse = await app.fetch(postJson("/workspace-templates", { gitUrl: specification }));
    const created = Value.Parse(workspaceTemplateResponseSchema, await createdResponse.json());
    const repeatedResponse = await app.fetch(postJson("/workspace-templates", { gitUrl: specification }));
    const repeated = Value.Parse(workspaceTemplateResponseSchema, await repeatedResponse.json());
    expect(createdResponse.status).toBe(200);
    expect(repeated.workspaceTemplate.id).toBe(created.workspaceTemplate.id);

    const listedResponse = await app.fetch(new Request("http://test.local/workspace-templates", { headers: { accept: "application/json" } }));
    const listed = Value.Parse(workspaceTemplateListResponseSchema, await listedResponse.json());
    expect(listed.workspaceTemplates.map((workspaceTemplate) => workspaceTemplate.id)).toEqual([created.workspaceTemplate.id]);

    const updatedResponse = await app.fetch(postJson(`/workspace-templates/${created.workspaceTemplate.id}`, { name: "JSON Project", gitUrl: specification }));
    const updated = Value.Parse(workspaceTemplateResponseSchema, await updatedResponse.json());
    expect(updated.workspaceTemplate.name).toBe("JSON Project");

    const environmentCreatedResponse = await app.fetch(postJson(`/workspace-templates/${created.workspaceTemplate.id}/environment`, { name: "EMPTY_OK", value: "" }));
    const environmentCreated = Value.Parse(environmentVariableResponseSchema, await environmentCreatedResponse.json());
    const environmentUpdatedResponse = await app.fetch(postJson(`/workspace-templates/${created.workspaceTemplate.id}/environment/${environmentCreated.environmentVariable.id}`, {
      name: "API_URL",
      value: "https://api.example",
    }));
    expect(Value.Parse(environmentVariableResponseSchema, await environmentUpdatedResponse.json()).environmentVariable)
      .toMatchObject({ name: "API_URL", value: "https://api.example" });

    const sensitive = "sensitive-value-never-return";
    const secretResponse = await app.fetch(postJson(`/workspace-templates/${created.workspaceTemplate.id}/secrets`, {
      envName: "POETRY_API_KEY",
      hostPattern: "api.poetry.example",
      placeholder: "",
      secretValue: sensitive,
    }));
    const secretText = await secretResponse.text();
    const secretCreated = Value.Parse(workspaceTemplateSecretResponseSchema, JSON.parse(secretText));
    expect(secretText).not.toContain(sensitive);
    expect(secretCreated.secret).not.toHaveProperty("secretValue");

    const secretUpdateResponse = await app.fetch(postJson(`/workspace-templates/${created.workspaceTemplate.id}/secrets/${secretCreated.secret.id}`, {
      envName: "POETRY_API_KEY",
      hostPattern: "packages.example",
      placeholder: "token",
    }));
    expect(await secretUpdateResponse.text()).not.toContain(sensitive);
    expect((await revealWorkspaceTemplateSecrets(created.workspaceTemplate.id))[0]?.secretValue).toBe(sensitive);

    const detailResponse = await app.fetch(new Request(`http://test.local/workspace-templates/${created.workspaceTemplate.id}`, { headers: { accept: "application/json" } }));
    const detailText = await detailResponse.text();
    const detail = Value.Parse(workspaceTemplateDetailResponseSchema, JSON.parse(detailText));
    expect(detail.workspaceTemplate.preloadImages).toEqual([]);
    expect(detail.workspaceTemplate.environment).toHaveLength(1);
    expect(detail.workspaceTemplate.secrets).toHaveLength(1);
    expect(detailText).not.toContain(sensitive);
    expect(detailText).not.toContain("encryptedSecret");

    const deletedSecretResponse = await app.fetch(postJson(`/workspace-templates/${created.workspaceTemplate.id}/secrets/${secretCreated.secret.id}/delete`, {}));
    const deletedEnvironmentResponse = await app.fetch(postJson(`/workspace-templates/${created.workspaceTemplate.id}/environment/${environmentCreated.environmentVariable.id}/delete`, {}));
    expect(Value.Parse(deletedWorkspaceTemplateSecretResponseSchema, await deletedSecretResponse.json()).deleted).toBe(true);
    expect(Value.Parse(deletedWorkspaceTemplateEnvironmentVariableResponseSchema, await deletedEnvironmentResponse.json()).deleted).toBe(true);
  });

  test("Secret JSON supports missing values and editable annotations", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/requirements.git")).workspaceTemplate;
    const path = `/workspace-templates/${workspaceTemplate.id}/secrets`;
    const values = { envName: "TOKEN", hostPattern: "api.example.com", annotation: "Integration tests" };
    const response = await app.fetch(postJson(path, values));
    expect(response.status).toBe(200);
    const { secret } = Value.Parse(workspaceTemplateSecretResponseSchema, await response.json());
    expect(secret).toMatchObject({ annotation: "Integration tests", configured: false });
    const updated = await app.fetch(postJson(`${path}/${secret.id}`, { ...values, annotation: "Report uploads" }));
    expect(Value.Parse(workspaceTemplateSecretResponseSchema, await updated.json()).secret).toMatchObject({ annotation: "Report uploads", configured: false });
    expect(secret).not.toHaveProperty("optional");
    expect(await revealWorkspaceTemplateSecrets(workspaceTemplate.id)).toEqual([]);
  });

  test("project JSON routes return structured errors for malformed and invalid bodies", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);
    const malformed = await app.fetch(new Request("http://test.local/workspace-templates", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{",
    }));
    const missing = await app.fetch(postJson("/workspace-templates", {}));

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_arguments" } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "invalid_arguments", message: "gitUrl is required" } });
  });

  test("project deletion JSON reports non-sensitive blockers and success", async () => {
    const first = (await addWorkspaceTemplate("https://github.com/org/first.git")).workspaceTemplate;
    const second = (await addWorkspaceTemplate("https://github.com/org/second.git")).workspaceTemplate;
    const { app, registry } = createTestApp();
    await registry.seed([{ id: "1585eff7", title: "poetry-slideshow", init: workspaceInitFromTemplate(first) }]);

    const blockedResponse = await app.fetch(postJson(`/workspace-templates/${first.id}/delete`, {}));
    const blocked = Value.Parse(workspaceTemplateDeletionBlockedResponseSchema, await blockedResponse.json());
    const deletedResponse = await app.fetch(postJson(`/workspace-templates/${second.id}/delete`, {}));

    expect(blocked).toEqual({
      deleted: false,
      blocked: true,
      references: [{ workspaceId: "1585eff7", title: "poetry-slideshow" }],
    });
    expect(deletedResponse.status).toBe(200);
    expect((await listWorkspaceTemplates()).workspaceTemplates).toEqual([first]);
  });

  test("warning acknowledgements require current state and do not hide later configuration changes", async () => {
    const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/warnings.git");
    const { app, registry } = createTestApp();
    await registry.seed([{ id: "abc12345", title: "Warnings", init: workspaceInitFromTemplate(workspaceTemplate) }]);
    await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "REGION", value: "eu" });
    const schema = Type.Object({ workspace: Type.Object({ warnings: Type.Array(Type.Object({ kind: Type.String(), state: Type.String() })), dismissedWarnings: Type.Record(Type.String(), Type.String()) }) });
    const status = async () => Value.Parse(schema, await (await app.fetch(new Request("http://test.local/workspaces/abc12345", { headers: { accept: "application/json" } }))).json()).workspace;
    const warning = workspaceWarnings(registry.get("abc12345")!, await getWorkspaceTemplateConfiguration(workspaceTemplate.id))[0]!;
    const path = `/workspaces/abc12345/warnings/${warning.kind}/dismiss`;
    expect((await app.fetch(postJson(path, { state: "stale" }))).status).toBe(400);
    expect(await (await app.fetch(postJson(path, { state: warning.state }))).json()).toEqual({ dismissed: true });
    expect((await status()).dismissedWarnings[warning.kind]).toBe(warning.state);
    await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "MODE", value: "test" });
    expect((await status()).warnings[0]!.state).not.toBe(warning.state);
    expect((await app.fetch(postJson(path, { state: warning.state }))).status).toBe(400);
  });

  test("lists workspace summaries as JSON while browser requests redirect", async () => {
    const { app, registry } = createTestApp();
    const workspaceTemplate = workspaceInitFromTemplate({
      id: "workspace-template-1",
      name: "demo",
      gitUrl: "https://example.test/demo.git",
      branch: null,
      sessionShareKey: "demo",
    });
    await registry.seed([{ id: "abc12345", title: "Automation target", parked: true, init: workspaceTemplate }]);

    const json = await app.fetch(new Request("http://test.local/workspaces", { headers: { accept: "application/json" } }));
    const browser = await app.fetch(new Request("http://test.local/workspaces"));

    expect(await json.json()).toEqual({
      workspaces: [{ id: "abc12345", title: "Automation target", phase: { kind: "runningPhase", busy: false }, requestingAttention: false, parked: true, workspaceTemplateId: "workspace-template-1" }],
    });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe("http://test.local/");
  });

  test("Agent type discovery uses distinct type IDs rather than Model provider IDs", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);
    const response = await app.fetch(new Request("http://test.local/agent-types", { headers: { accept: "application/json" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      defaultAgentTypeId: "builtin",
      agentTypes: expect.arrayContaining([expect.objectContaining({ id: "builtin" }), expect.objectContaining({ id: "codex" }), expect.objectContaining({ id: "codex-cli" })]),
    });
    expect((await app.fetch(new Request("http://test.local/agent-providers"))).status).toBe(404);
  });

  test("OpenAPI advertises the supported automation surface", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);

    const removed = await app.fetch(postJson("/api/workspaces", {}));
    const response = await app.fetch(new Request("http://test.local/openapi.json"));
    const specification = await response.json();

    expect(removed.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(specification).toMatchObject({
      paths: {
        "/agent-types": {},
        "/workspaces": {},
        "/workspaces/{id}": {
          get: { parameters: expect.arrayContaining([
            expect.objectContaining({ name: "agent", in: "query" }),
            expect.objectContaining({ name: "workView", in: "query" }),
          ]) },
        },
        "/workspaces/{id}/commands/{commandId}": {},
        "/workspace-templates": {},
        "/workspace-templates/{workspaceTemplateId}": {},
        "/workspace-templates/{workspaceTemplateId}/settings": {
          get: { parameters: expect.arrayContaining([expect.objectContaining({ name: "section", in: "query" })]) },
        },
        "/workspace-templates/{workspaceTemplateId}/workspaces/new": {},
        "/workspace-templates/new": {},
        "/workspaces/new": {},
        "/settings": {},
        "/workspace-templates/{workspaceTemplateId}/environment/{variableId}/delete": {},
        "/workspace-templates/{workspaceTemplateId}/secrets/{secretId}/delete": {},
        "/workspace-templates/{workspaceTemplateId}/delete": {},
        "/workspaces/{id}/agents/{agentId}/close": {
          post: { responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/AgentCloseResult" } } } },
          } },
        },
      },
      components: { schemas: { CommandResult: {
        properties: { command: { properties: { agentId: { type: "string", format: "uuid" } } } },
      } } },
    });
    expect(Object.keys(specification.components.schemas.CreateWorkspace.properties.agent.properties).sort()).toEqual([
      "agentTypeId", "attachmentDraft", "initialPrompt", "model", "thinkingLevel",
    ]);
    expect(specification).not.toMatchObject({ paths: { "/api/workspaces": expect.anything() } });
    expect(specification).not.toMatchObject({ paths: { "/workspaces/{id}/agents/{conversationId}/close": expect.anything() } });
  });
});
