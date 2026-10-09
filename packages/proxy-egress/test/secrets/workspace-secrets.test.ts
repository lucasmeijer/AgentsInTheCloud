import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, createWorkspaceTemplateSecret, updateWorkspaceTemplateSecret, deleteWorkspaceTemplateSecret, type GitWorkspaceTemplateInitInstruction } from "@agents-in-the-cloud/workspace-templates";
import { createWorkspaceSecretContext, registerWorkspaceRequestTransform, clearGitHubToken, forgetWorkspaceSecretContext, getWorkspaceSecretContext, setGitHubToken } from "../../src/secrets/workspace-secrets.ts";

function workspaceTemplateInit(workspaceTemplateId: string): GitWorkspaceTemplateInitInstruction {
  return { type: "project.git", projectId: workspaceTemplateId, name: "Project", gitUrl: "https://github.com/org/repo.git", branch: null, sessionShareKey: "Project" };
}

describe("workspace secrets", () => {
  let previousDataDir: string | undefined;
  let previousGitHubToken: string | undefined;
  let dataDir: string;

  beforeEach(async () => {
    previousDataDir = process.env.ATELIER_DATA_DIR;
    previousGitHubToken = process.env.GH_TOKEN;
    dataDir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-workspace-secrets-"));
    process.env.ATELIER_DATA_DIR = dataDir;
    delete process.env.GH_TOKEN;
  });

  afterEach(async () => {
    clearGitHubToken();
    forgetWorkspaceSecretContext("test-workspace");
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("uses deterministic placeholders for workspace env secrets", async () => {
    setGitHubToken("real-secret");
    const context = await createWorkspaceSecretContext("test-workspace");

    expect(context.env.GH_TOKEN).toBe("AGENTSINTHECLOUD_PROXY_READY_GH_TOKEN");
    expect(context.secrets).toContainEqual({
      name: "GH_TOKEN",
      placeholder: "AGENTSINTHECLOUD_PROXY_READY_GH_TOKEN",
      hosts: ["github.com", "api.github.com"],
    });
  });

  test("includes encrypted Workspace template secrets with default and custom placeholders", async () => {
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git")).workspaceTemplate;
    await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "API_TOKEN", hostPattern: "api.example.com, *.example.org", secretValue: "real-secret" });
    await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "STRICT_TOKEN", hostPattern: "api.example.com", placeholder: "sk-test-placeholder", secretValue: "strict-secret" });

    await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "MISSING_TOKEN", hostPattern: "api.example.com", annotation: "Integration tests" });
    await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "UNCONFIGURED_TOKEN", hostPattern: "api.example.com" });
    const context = await createWorkspaceSecretContext("test-workspace", workspaceTemplateInit(workspaceTemplate.id));
    expect(context.env).not.toHaveProperty("MISSING_TOKEN");
    expect(context.env).not.toHaveProperty("UNCONFIGURED_TOKEN");
    const result = await context.hooks.onRequest(new Request("https://api.example.com/v1/sk-test-placeholder", { headers: { authorization: "Bearer sk-test-placeholder" } }));

    expect(context.env.API_TOKEN).toBe("AGENTSINTHECLOUD_PROXY_READY_API_TOKEN");
    expect(context.env.STRICT_TOKEN).toBe("sk-test-placeholder");
    expect(context.secrets).toContainEqual({ name: "API_TOKEN", placeholder: "AGENTSINTHECLOUD_PROXY_READY_API_TOKEN", hosts: ["api.example.com", "*.example.org"] });
    expect(context.secrets).toContainEqual({ name: "STRICT_TOKEN", placeholder: "sk-test-placeholder", hosts: ["api.example.com"] });
    expect(result.headers.get("authorization")).toBe("Bearer strict-secret");
    expect(result.url).toBe("https://api.example.com/v1/sk-test-placeholder");
  });

  test.each(["api.example.com; *.example.org", " ; api.example.com, ; *.example.org;; "])("accepts semicolon-separated secret hosts: %s", async (hostPattern) => {
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git")).workspaceTemplate;
    await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "API_TOKEN", hostPattern, secretValue: "real-secret" });
    const context = await createWorkspaceSecretContext("test-workspace", workspaceTemplateInit(workspaceTemplate.id));

    expect(context.secrets).toContainEqual({ name: "API_TOKEN", placeholder: "AGENTSINTHECLOUD_PROXY_READY_API_TOKEN", hosts: ["api.example.com", "*.example.org"] });
    for (const host of ["api.example.com", "service.example.org"]) {
      const result = await context.hooks.onRequest(new Request(`https://${host}/`, { headers: { authorization: `Bearer ${context.env.API_TOKEN}` } }));
      expect(result.headers.get("authorization")).toBe("Bearer real-secret");
    }
    expect(() => context.hooks.onRequest(new Request("https://other.example.net/", { headers: { authorization: `Bearer ${context.env.API_TOKEN}` } }))).toThrow("secret API_TOKEN not allowed for host: other.example.net");
  });

  test("reloads persisted Workspace template secrets when rebuilding context after restart", async () => {
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git")).workspaceTemplate;
    await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "PACKAGE_TOKEN", hostPattern: "registry.example.com", placeholder: "PACKAGE_TOKEN", secretValue: "real-package-secret" });
    const init = workspaceTemplateInit(workspaceTemplate.id);
    await createWorkspaceSecretContext("test-workspace", init);
    forgetWorkspaceSecretContext("test-workspace");

    const context = await getWorkspaceSecretContext("test-workspace", async (workspaceId) => {
      expect(workspaceId).toBe("test-workspace");
      return init;
    });
    const result = await context.hooks.onRequest(new Request("https://registry.example.com/v2/", { headers: { authorization: "Bearer PACKAGE_TOKEN" } }));

    expect(context.env.PACKAGE_TOKEN).toBe("PACKAGE_TOKEN");
    expect(context.secrets).toContainEqual({ name: "PACKAGE_TOKEN", placeholder: "PACKAGE_TOKEN", hosts: ["registry.example.com"] });
    expect(result.headers.get("authorization")).toBe("Bearer real-package-secret");
  });

  test("new, replaced and deleted secrets take effect on running workspace egress without restart", async () => {
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/repo.git")).workspaceTemplate;
    const init = workspaceTemplateInit(workspaceTemplate.id);
    const initial = await createWorkspaceSecretContext("test-workspace", init);
    expect(initial.env.TOKEN).toBeUndefined();
    const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "TOKEN", hostPattern: "api.example.com", secretValue: "first" });
    const load = () => getWorkspaceSecretContext("test-workspace", async () => init);
    const first = await load();
    const outbound = () => new Request("https://api.example.com/", { headers: { authorization: "Bearer AGENTSINTHECLOUD_PROXY_READY_TOKEN" } });
    expect((await first.hooks.onRequest(outbound())).headers.get("authorization")).toBe("Bearer first");
    // The old process's environment is unchanged; callers explicitly supply the placeholder.
    expect(initial.env.TOKEN).toBeUndefined();
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { envName: "TOKEN", hostPattern: "api.example.com", secretValue: "second" });
    expect((await (await load()).hooks.onRequest(outbound())).headers.get("authorization")).toBe("Bearer second");
    await deleteWorkspaceTemplateSecret(workspaceTemplate.id, secret.id);
    expect((await load()).env.TOKEN).toBeUndefined();
  });

  test("path injection defaults to Telegram only and respects live per-secret overrides", async () => {
    setGitHubToken("github-credential");
    const workspaceTemplate = (await addWorkspaceTemplate("https://github.com/org/path-secrets.git")).workspaceTemplate;
    const init = workspaceTemplateInit(workspaceTemplate.id);
    const values = { envName: "BOT_TOKEN", hostPattern: "api.telegram.org", secretValue: "123:telegram-credential" };
    const bot = await createWorkspaceTemplateSecret(workspaceTemplate.id, values);
    const load = () => getWorkspaceSecretContext("test-workspace", async () => init);
    for (const scheme of ["http", "https"]) {
      const context = await load();
      const githubUrl = `${scheme}://github.com/${context.env.GH_TOKEN}`;
      expect((await context.hooks.onRequest(new Request(githubUrl))).url).toBe(githubUrl);
      const githubAuth = await context.hooks.onRequest(new Request(`${scheme}://api.github.com/user`, { headers: { authorization: `Bearer ${context.env.GH_TOKEN}` } }));
      expect(githubAuth.headers.get("authorization")).toBe("Bearer github-credential");
    }
    const botRequest = () => new Request("https://api.telegram.org/botAGENTSINTHECLOUD_PROXY_READY_BOT_TOKEN/getMe");
    expect((await (await load()).hooks.onRequest(botRequest())).url).toBe("https://api.telegram.org/bot123:telegram-credential/getMe");
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, bot.id, { ...values, allowInPath: false });
    expect((await (await load()).hooks.onRequest(botRequest())).url).toBe(botRequest().url);
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, bot.id, { ...values, allowInPath: true });
    expect((await (await load()).hooks.onRequest(botRequest())).url).toContain("bot123:telegram-credential/");
    const custom = await createWorkspaceTemplateSecret(workspaceTemplate.id, { envName: "CUSTOM", hostPattern: "api.example.com", secretValue: "custom-credential", allowInPath: true });
    const customRequest = () => new Request("https://api.example.com/AGENTSINTHECLOUD_PROXY_READY_CUSTOM");
    expect((await (await load()).hooks.onRequest(customRequest())).url).toBe("https://api.example.com/custom-credential");
    await updateWorkspaceTemplateSecret(workspaceTemplate.id, custom.id, { envName: "CUSTOM", hostPattern: "api.example.com", allowInPath: false, secretValue: "custom-credential" });
    expect((await (await load()).hooks.onRequest(customRequest())).url).toBe(customRequest().url);
  });

  test("egress reaches only public internet destinations", async () => {
    const context = await createWorkspaceSecretContext("test-workspace");
    for (const ip of ["127.0.0.1", "169.254.169.254", "::1", "0.0.0.0", "224.0.0.1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(await context.hooks.isIpAllowed!({ hostname: "destination.example", ip, family: ip.includes(":") ? 6 : 4, port: 443, protocol: "https" })).toBe(false);
    }
    for (const ip of ["10.200.0.2", "192.168.1.1", "172.17.0.1", "100.64.0.1", "100.100.100.100", "fd00::1", "fd7a:115c:a1e0::2", "2001:db8::1"]) {
      expect(await context.hooks.isIpAllowed!({ hostname: "destination.example", ip, family: ip.includes(":") ? 6 : 4, port: 443, protocol: "https" })).toBe(false);
    }
    for (const ip of ["93.184.215.14", "8.8.8.8", "2606:4700:10::6814:179a"]) {
      expect(await context.hooks.isIpAllowed!({ hostname: "example.com", ip, family: ip.includes(":") ? 6 : 4, port: 443, protocol: "https" })).toBe(true);
    }
  });

  test("passes an inherited placeholder onward for nested AgentsInTheCloud", async () => {
    process.env.GH_TOKEN = "AGENTSINTHECLOUD_PROXY_READY_GH_TOKEN";

    const context = await createWorkspaceSecretContext("test-workspace");
    const basic = Buffer.from("x-access-token:AGENTSINTHECLOUD_PROXY_READY_GH_TOKEN").toString("base64");
    const result = await context.hooks.onRequest(new Request("https://github.com/repo.git", { headers: { authorization: `Basic ${basic}` } }));

    expect(result.headers.get("authorization")).toBe(`Basic ${basic}`);
  });
});

test("host credential transforms precede secret replacement and are replaceable without leaking into env", async () => {
  const workspaceId = "request-transform-test";
  try {
    const before = await createWorkspaceSecretContext(workspaceId);
    registerWorkspaceRequestTransform("test-bridge", async (request, registerSecret) => {
      if (request.headers.has("x-bridge")) {
        request.headers.set("x-bridge", "resolved");
        registerSecret("resolved");
      }
      return request;
    });
    registerWorkspaceRequestTransform("test-bridge-clone", async request => new Request(request));
    const context = await getWorkspaceSecretContext(workspaceId, async () => undefined);
    expect(context).not.toBe(before);
    expect(Object.values(context.env)).not.toContain("resolved");
    const request = new Request("https://model.example/", { headers: { "x-bridge": "placeholder" } });
    const transformed = await context.hooks.onRequest(request);
    expect(transformed).not.toBe(request);
    expect(transformed.headers.get("x-bridge")).toBe("resolved");
    expect(context.hooks.scrubResponseHeader("https://model.example/resolved", transformed)).toBe("https://model.example/[REDACTED]");
    registerWorkspaceRequestTransform("test-bridge", async () => { throw new Error("Provider disconnected"); });
    await expect(context.hooks.onRequest(new Request("https://model.example/"))).rejects.toThrow("Provider disconnected");
  } finally {
    registerWorkspaceRequestTransform("test-bridge", async (request) => request);
    registerWorkspaceRequestTransform("test-bridge-clone", async (request) => request);
    forgetWorkspaceSecretContext(workspaceId);
  }
});
