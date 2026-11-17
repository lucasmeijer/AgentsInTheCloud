import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createHttpHooks } from "../../proxy-egress/src/secrets/placeholder-hooks.ts";
import { createPiCliConfiguration, createPiCliCredentialTransform, piCliCredentialHosts, piCliModelUnavailableReason } from "../src/server/pi-cli-bridge.ts";

function model(provider: string, api: Api = "openai-completions", baseUrl = `https://${provider}.example/v1`): Model<Api> {
  return { provider, id: "test-model", name: "Test model", api, baseUrl, reasoning: true, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000, thinkingLevelMap: { minimal: null } };
}
function fixture(models: Model<Api>[], auth: Record<string, AuthResult>) {
  return {
    models, auth,
    getAvailable: async (provider?: string) => models.filter((m) => (!provider || m.provider === provider) && auth[m.provider]),
    checkAuth: async (provider: string) => auth[provider] ? { type: auth[provider]!.source === "OAuth" ? "oauth" as const : "api_key" as const } : undefined,
    getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    getAuth: async (ref: Model<Api>) => auth[ref.provider],
  };
}
function jwt(account: string) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.real-signature`;
}

test("exports enabled models, labels, capabilities and custom models without credentials or raw auth configuration", async () => {
  const models = [model("custom"), model("openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api"), model("anthropic", "anthropic-messages", "https://api.anthropic.com")];
  const runtime = fixture(models, {
    custom: { auth: { apiKey: "custom-secret", headers: { "x-custom-auth": "custom-header-secret" } } },
    "openai-codex": { auth: { apiKey: jwt("real-account") }, source: "OAuth" },
    anthropic: { auth: { apiKey: "sk-ant-oat-real-secret" }, source: "OAuth" },
  });
  const config = await createPiCliConfiguration(runtime, [{ provider: "custom", id: "test-model", label: "My enabled model" }, { provider: "anthropic", id: "test-model", label: "Claude" }]);
  expect(config.enabledModels).toEqual(["custom/test-model", "anthropic/test-model"]);
  expect(config.models.providers.custom!.models[0]!.name).toBe("My enabled model");
  expect(config.models.providers.custom!.models[0]!.thinkingLevelMap).toEqual({ minimal: null });
  const serialized = JSON.stringify(config);
  for (const secret of ["custom-secret", "custom-header-secret", "real-account", "real-signature", "sk-ant-oat-real-secret", "refresh"]) expect(serialized).not.toContain(secret);

  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-"));
  try {
    await writeFile(join(directory, "models.json"), JSON.stringify(config.models));
    await writeFile(join(directory, "auth.json"), JSON.stringify(config.auth));
    const imported = await ModelRuntime.create({ modelsPath: join(directory, "models.json"), authPath: join(directory, "auth.json"), modelsStorePath: join(directory, "cache.json"), allowModelNetwork: false });
    expect(imported.getError()).toBeUndefined();
    const available = await imported.getAvailable();
    for (const m of models) expect(available.some((item) => item.provider === m.provider && item.id === m.id)).toBe(true);
    expect((await imported.getAuth(imported.getModel("custom", "test-model")!))!.auth.headers!["x-custom-auth"]).toBe(config.models.providers.custom!.models[0]!.headers!["x-custom-auth"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resolves fresh credentials on each request and works with a newly created bridge after restart", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "first-key", headers: { "x-key": "first-header" } } } });
  const config = await createPiCliConfiguration(runtime, []);
  const headers = { Authorization: `Bearer ${config.auth.custom!.key}`, ...config.models.providers.custom!.models[0]!.headers };
  for (const version of ["first", "refreshed"]) {
    runtime.auth.custom = { auth: { apiKey: `${version}-key`, headers: { "x-key": `${version}-header` } } };
    const transform = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest;
    const request = await transform(new Request("https://custom.example/v1/chat/completions", { method: "POST", headers, body: '{"messages":[]}' }));
    expect(request.headers.get("authorization")).toBe(`Bearer ${version}-key`);
    expect(request.headers.get("x-key")).toBe(`${version}-header`);
    expect(await request.text()).toBe('{"messages":[]}');
  }
});

test("Codex receives a real access token and account header while the CLI gets only a synthetic JWT", async () => {
  const runtime = fixture([model("openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api")], { "openai-codex": { auth: { apiKey: jwt("account-one") }, source: "OAuth" } });
  const config = await createPiCliConfiguration(runtime, []);
  const key = config.auth["openai-codex"]!.key;
  const claims = JSON.parse(Buffer.from(key.split(".")[1]!, "base64url").toString());
  runtime.auth["openai-codex"]!.auth.apiKey = jwt("account-two");
  const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request("https://chatgpt.com/backend-api/codex/responses", { headers: { authorization: `Bearer ${key}`, "chatgpt-account-id": claims["https://api.openai.com/auth"].chatgpt_account_id } }));
  expect(request.headers.get("authorization")).toBe(`Bearer ${jwt("account-two")}`);
  expect(request.headers.get("chatgpt-account-id")).toBe("account-two");
});

test("OpenAI placeholders keep the shape Pi uses to tell API keys from Sign in with ChatGPT", async () => {
  const openai = { ...model("openai", "openai-responses", "https://api.openai.com/v1"), maxTokens: 4000 };
  async function cliRequestOmitsMaxOutputTokens(key: string): Promise<boolean> {
    let omitted: boolean | undefined;
    await streamOpenAIResponses({ ...openai, api: "openai-responses" }, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
      apiKey: key, maxTokens: 2000,
      onPayload(body) {
        omitted = Value.Parse(Type.Object({ max_output_tokens: Type.Optional(Type.Number()) }), body).max_output_tokens === undefined;
        throw new Error("Stop after serialization; no network request");
      },
    }).result();
    return omitted!;
  }
  for (const [secret, subscription] of [["sk-proj-real-secret", false], ["chatgpt-access-token", true]] as const) {
    const runtime = fixture([openai], { openai: { auth: { apiKey: secret } } });
    const key = (await createPiCliConfiguration(runtime, [])).auth.openai!.key;
    expect(key).not.toContain(secret);
    expect(await cliRequestOmitsMaxOutputTokens(key)).toBe(subscription);
    const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request("https://api.openai.com/v1/responses", { headers: { authorization: `Bearer ${key}` } }));
    expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
  }
});

test("Anthropic placeholders keep the shape Pi uses to tell API keys from Claude subscriptions", async () => {
  const anthropic = model("anthropic", "anthropic-messages", "https://api.anthropic.com");
  for (const [secret, header, subscription] of [["sk-ant-api03-secret", "x-api-key", false], ["sk-ant-oat01-secret", "authorization", true]] as const) {
    const runtime = fixture([anthropic], { anthropic: { auth: { apiKey: secret }, source: subscription ? "OAuth" : undefined } });
    expect(await piCliModelUnavailableReason(runtime, anthropic)).toBeUndefined();
    const key = (await createPiCliConfiguration(runtime, [])).auth.anthropic!.key;
    expect(key).not.toContain(secret);
    expect(key.includes("sk-ant-oat")).toBe(subscription);
    const value = subscription ? `Bearer ${key}` : key;
    const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request("https://api.anthropic.com/v1/messages", { headers: { [header]: value, "user-agent": "claude-cli/2.1.280", "x-app": "cli" } }));
    expect(request.headers.get(header)).toBe(subscription ? `Bearer ${secret}` : secret);
    expect([request.headers.get("user-agent"), request.headers.get("x-app")]).toEqual(subscription ? ["pi", null] : ["claude-cli/2.1.280", "cli"]);
  }
});

test("rejects foreign hosts, changed endpoints, disconnected providers and malformed markers", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "secret" } } });
  const config = await createPiCliConfiguration(runtime, []);
  const transform = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest;
  const request = (url: string) => new Request(url, { headers: { authorization: `Bearer ${config.auth.custom!.key}` } });
  for (const url of ["https://attacker.example/", "http://custom.example/", "https://custom.example:444/"]) await expect(transform(request(url))).rejects.toThrow("not allowed");
  runtime.models[0]!.baseUrl = "https://changed.example/v1";
  await expect(transform(request("https://custom.example/v1"))).rejects.toThrow("not allowed");
  delete runtime.auth.custom;
  await expect(transform(request("https://changed.example/v1"))).rejects.toThrow("no longer connected");
  await expect(transform(new Request("https://custom.example/", { headers: { authorization: "agents-in-the-cloud-pi-e30-end" } }))).rejects.toThrow("Invalid Pi credential placeholder");
});

test("supports query API keys without changing unrelated query semantics", async () => {
  const runtime = fixture([model("google", "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta")], { google: { auth: { apiKey: "secret+/=&" } } });
  const config = await createPiCliConfiguration(runtime, []);
  const transform = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest;
  const request = await transform(new Request(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.auth.google!.key}&alt=sse`));
  expect(new URL(request.url).searchParams.get("key")).toBe("secret+/=&");
  expect(new URL(request.url).searchParams.get("alt")).toBe("sse");
  await expect(transform(new Request(`https://attacker.example/?key=${config.auth.google!.key}`))).rejects.toThrow("not allowed");
});

test("materializes Cloudflare endpoint parameters and header-only credentials without copying env or secrets", async () => {
  const runtime = fixture([model("cloudflare-ai-gateway", "openai-completions", "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat")], {
    "cloudflare-ai-gateway": { auth: { headers: { "cf-aig-authorization": "Bearer cf-secret", Authorization: null, "x-api-key": null } }, env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_GATEWAY_ID: "gateway" } },
  });
  const config = await createPiCliConfiguration(runtime, []);
  const exported = config.models.providers["cloudflare-ai-gateway"]!.models[0]!;
  expect(exported.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/compat");
  expect(JSON.stringify(config)).not.toContain("cf-secret");
  const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request(`${exported.baseUrl}/chat/completions`, { headers: exported.headers }));
  expect(request.headers.get("cf-aig-authorization")).toBe("Bearer cf-secret");
  expect(request.headers.has("authorization")).toBe(false);
  expect(request.headers.has("x-api-key")).toBe(false);
});

test("refuses host-only credential chains, but supports Bedrock bearer tokens and Vertex API keys", async () => {
  const models = [model("amazon-bedrock", "bedrock-converse-stream", "https://bedrock-runtime.us-east-1.amazonaws.com"), model("google-vertex", "google-vertex", "https://{location}-aiplatform.googleapis.com")];
  const runtime = fixture(models, { "amazon-bedrock": { auth: {}, env: { AWS_PROFILE: "secret-profile" } }, "google-vertex": { auth: {}, env: { GOOGLE_APPLICATION_CREDENTIALS: "/host/secret.json" } } });
  for (const m of models) expect(await piCliModelUnavailableReason(runtime, m)).toContain("requires an API key or bearer token");
  expect((await createPiCliConfiguration(runtime, [])).models.providers).toEqual({});
  runtime.auth["amazon-bedrock"] = { auth: { apiKey: "bedrock-token" } };
  runtime.auth["google-vertex"] = { auth: { apiKey: "vertex-key" } };
  const config = await createPiCliConfiguration(runtime, []);
  expect(config.models.providers["google-vertex"]!.models[0]!.baseUrl).toBe("https://aiplatform.googleapis.com");
  const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request("https://aiplatform.googleapis.com/v1/publishers/google/models/model:streamGenerateContent", { headers: { "x-goog-api-key": config.auth["google-vertex"]!.key } }));
  expect(request.headers.get("x-goog-api-key")).toBe("vertex-key");
});

test("rejects embedded URL credentials instead of copying them into the workspace", async () => {
  const runtime = fixture([model("custom", "openai-completions", "https://user:secret@custom.example/v1")], { custom: { auth: { apiKey: "secret" } } });
  await expect(createPiCliConfiguration(runtime, [])).rejects.toThrow("without embedded credentials");
});

test("credential bridge intercepts current model hosts and authentication endpoint overrides", async () => {
  const runtime = fixture([
    model("openai", "openai-responses", "https://api.openai.com/v1"),
    model("custom"),
    model("anthropic", "anthropic-messages", "https://api.anthropic.com"),
  ], {
    openai: { auth: { apiKey: "access-token", baseUrl: "https://chatgpt.com/backend-api" } },
    custom: { auth: { apiKey: "secret" } },
    anthropic: { auth: { apiKey: "sk-ant-oat-secret" } },
  });
  expect(await piCliCredentialHosts(runtime)).toEqual(["chatgpt.com", "custom.example", "api.anthropic.com"]);
  runtime.auth.openai = { auth: { apiKey: "sk-secret" } };
  expect(await piCliCredentialHosts(runtime)).toEqual(["api.openai.com", "custom.example", "api.anthropic.com"]);
});

test("bridge credentials are scrubbed from reflected headers and queries, including after refresh", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "first-key+/=", headers: { "x-key": "first-header" } } } });
  const config = await createPiCliConfiguration(runtime, []);
  const hooks = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks;
  const request = () => new Request(`https://custom.example/v1?key=${config.auth.custom!.key}`, {
    headers: { authorization: `Bearer ${config.auth.custom!.key}`, ...config.models.providers.custom!.models[0]!.headers },
  });
  const first = await hooks.onRequest(request());
  runtime.auth.custom = { auth: { apiKey: "refreshed-key+/=", headers: { "x-key": "refreshed-header" } } };
  const second = await hooks.onRequest(request());
  for (const outbound of [second, first]) {
    expect(hooks.scrubResponseHeader(outbound.url, outbound)).toBe("https://custom.example/v1?key=[REDACTED]");
    expect(hooks.scrubResponseHeader(outbound.headers.get("authorization")!, outbound)).toBe("Bearer [REDACTED]");
    expect(hooks.scrubResponseHeader(outbound.headers.get("x-key")!, outbound)).toBe("[REDACTED]");
  }
});

test("Pi cannot bypass path permissions by putting a bridge placeholder into a URL path", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "private-key" } } });
  const config = await createPiCliConfiguration(runtime, []);
  const hooks = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks;
  await expect(hooks.onRequest(new Request(`https://custom.example/v1/${config.auth.custom!.key}`))).rejects.toThrow("cannot be injected into URL paths");
  await expect(hooks.onRequest(new Request(`https://custom.example/v1/${config.auth.custom!.key}`, {
    headers: { authorization: `Bearer ${config.auth.custom!.key}` },
  }))).rejects.toThrow("cannot be injected into URL paths");
});

test("bridge-supplied Basic authentication protects the encoded credential as well as the complete header", async () => {
  const encoded = Buffer.from("user:bridge-password").toString("base64");
  const runtime = fixture([model("custom")], { custom: { auth: { headers: { authorization: `Basic ${encoded}` } } } });
  const config = await createPiCliConfiguration(runtime, []);
  const hooks = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks;
  const outbound = await hooks.onRequest(new Request("https://custom.example/v1", { headers: config.models.providers.custom!.models[0]!.headers }));
  expect(hooks.scrubResponseHeader(outbound.headers.get("authorization")!, outbound)).toBe("[REDACTED]");
  expect(hooks.scrubResponseHeader(encoded, outbound)).toBe("[REDACTED]");
});
