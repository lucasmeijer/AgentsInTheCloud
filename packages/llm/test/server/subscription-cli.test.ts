import { expect, spyOn, test } from "bun:test";
import { createWorkspaceSecretContext } from "@agents-in-the-cloud/proxy-egress/server";
import { maskCodexAccountDiscovery, registerSubscriptionCli, seededPiAuth, subscriptionCliFiles } from "../../src/server/subscription-cli.ts";
import { codexAccountId } from "../../src/server/codex-token.ts";
import { anthropicUsageSource } from "../../src/server/anthropic-subscription-usage.ts";
import { forgetSubscriptionInference, providersInLastInferenceWindow } from "../../src/server/recent-subscription-activity.ts";

test("Codex receives ChatGPT auth, not API-key auth or refresh credentials", () => {
  const file = subscriptionCliFiles().find((file) => file.provider === "openai-codex")!;
  const auth = JSON.parse(file.content);
  expect(auth.auth_mode).toBe("chatgpt");
  expect(auth.OPENAI_API_KEY).toBeNull();
  expect(auth.tokens.access_token).toBe(file.marker);
  expect(auth.tokens.refresh_token).toBe("");
  const parts = auth.tokens.id_token.split(".");
  expect(parts).toHaveLength(3);
  expect(parts.every(Boolean)).toBe(true);
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  expect(claims["https://api.openai.com/auth"].chatgpt_account_id).toBe(auth.tokens.account_id);
});

test("Codex routing discovery sees its placeholder as the selected account without changing other workspaces", async () => {
  const response = new Response(JSON.stringify({ accounts: [
    { id: "account-123", workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" },
    { id: "other-account" },
  ], account_ordering: ["other-account", "account-123"], default_account_id: "account-123" }), { headers: { "content-length": "200", "content-type": "application/json" } });
  const translated = await maskCodexAccountDiscovery(response, "account-123");
  const selected = JSON.parse(subscriptionCliFiles().find(file => file.provider === "openai-codex")!.content).tokens.account_id;
  expect(await translated.json()).toEqual({ accounts: [
    { id: selected, workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" },
    { id: "other-account" },
  ], account_ordering: ["other-account", selected], default_account_id: selected });
  expect(translated.headers.has("content-length")).toBe(false);
  expect((await response.json()).accounts[0].id).toBe("account-123");
});

test("workspace proxy translates Codex discovery only on ChatGPT's account endpoint", async () => {
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
  // SAFETY: registerSubscriptionCli only calls getAuth on the runtime.
  registerSubscriptionCli(async () => ({ getAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }) }) as any);
  const context = await createWorkspaceSecretContext("codex-discovery-test");
  // SAFETY: The workspace secret context always returns a rewritten Request for matched hosts.
  const request = await context.hooks.onRequest!(new Request("https://chatgpt.com/backend-api/wham/accounts/check", { headers: { authorization: "Bearer agents-in-the-cloud-subscription-codex-access", "chatgpt-account-id": "agents-in-the-cloud-subscription-codex-account" } })) as Request;
  expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(request.headers.get("chatgpt-account-id")).toBe("account-123");
  const upstream = new Response(JSON.stringify({ accounts: [{ id: "account-123" }] }));
  // SAFETY: The registered codex-accounts-check transform returns a Response for accounts/check.
  const result = await context.hooks.onResponse!(upstream, request) as Response;
  expect((await result.json()).accounts[0].id).toBe("agents-in-the-cloud-subscription-codex-account");
  const unrelated = new Response("untouched");
  expect(await context.hooks.onResponse!(unrelated, new Request("https://chatgpt.com/backend-api/wham/usage"))).toBe(unrelated);
});

test("proxy records only successful Codex inference using AgentsInTheCloud's subscription", async () => {
  forgetSubscriptionInference("openai-codex");
  // SAFETY: registerSubscriptionCli only calls getAuth on the runtime.
  registerSubscriptionCli(async () => ({ getAuth: async () => ({ source: "OAuth", auth: { apiKey: "real-token" } }) }) as any);
  const context = await createWorkspaceSecretContext("codex-inference-test");
  const request = new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", headers: { authorization: "Bearer real-token" } });
  await context.hooks.onResponse!(new Response("error", { status: 429 }), request);
  expect(providersInLastInferenceWindow()).toEqual([]);
  await context.hooks.onResponse!(new Response("ok"), new Request(request.url, { method: "POST", headers: { authorization: "Bearer other-token" } }));
  expect(providersInLastInferenceWindow()).toEqual([]);
  await context.hooks.onResponse!(new Response("ok"), request);
  expect(providersInLastInferenceWindow()).toContain("openai-codex");
  forgetSubscriptionInference("openai-codex");
});

test("invalid account discovery remains an upstream response", async () => {
  const response = new Response("not JSON");
  expect(await maskCodexAccountDiscovery(response, "account-123")).toBe(response);
});

test("Claude Code receives inference-scoped OAuth placeholders", () => {
  const file = subscriptionCliFiles().find((file) => file.provider === "anthropic")!;
  expect(file.path).toBe(".claude/.credentials.json");
  const auth = JSON.parse(file.content).claudeAiOauth;
  expect(auth.accessToken).toBe(file.marker);
  expect(auth.refreshToken).toBeNull();
  expect(auth.scopes).toContain("user:inference");
  expect(auth.expiresAt).toBeGreaterThan(Date.now());
});

test("workspace proxy records Claude Code's subscription limits only for AgentsInTheCloud's credential", async () => {
  // SAFETY: registerSubscriptionCli only calls getAuth on the runtime.
  registerSubscriptionCli(async () => ({ getAuth: async () => ({ source: "OAuth", auth: { apiKey: "real-token" } }) }) as any);
  const context = await createWorkspaceSecretContext("anthropic-usage-test");
  forgetSubscriptionInference("anthropic");
  const observe = spyOn(anthropicUsageSource, "observe");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  // SAFETY: The workspace secret context always returns a rewritten Request for matched hosts.
  const request = await context.hooks.onRequest!(new Request("https://api.anthropic.com/v1/messages", { method: "POST", headers: { authorization: "Bearer agents-in-the-cloud-subscription-anthropic-access" } })) as Request;
  const limits = { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-5h-utilization": "0.2" };
  const upstream = new Response("stream", { headers: limits });
  expect(await context.hooks.onResponse!(upstream, request)).toBe(upstream);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(observe.mock.calls[0]![0]).toBe(upstream.headers);
  expect(providersInLastInferenceWindow()).toContain("anthropic");
  forgetSubscriptionInference("anthropic");
  await context.hooks.onResponse!(new Response("", { headers: limits }), new Request("https://api.anthropic.com/v1/messages", { headers: { authorization: "Bearer workspace-login" } }));
  expect(observe).toHaveBeenCalledTimes(1);
  expect(providersInLastInferenceWindow()).toEqual([]);
  await context.hooks.onResponse!(new Response("stream"), request);
  expect(providersInLastInferenceWindow()).toContain("anthropic");
  expect(observe).toHaveBeenCalledTimes(1);
  forgetSubscriptionInference("anthropic");
  const malformed = new Response("stream", { headers: { ...limits, "anthropic-ratelimit-unified-5h-utilization": "lots" } });
  expect(await context.hooks.onResponse!(malformed, request)).toBe(malformed);
  expect(warn).toHaveBeenCalledWith("[usage] Anthropic returned unrecognized rate limit headers.");
  observe.mockRestore();
  warn.mockRestore();
});

test("Codex placeholders use legacy OAuth when both OpenAI subscriptions are connected", async () => {
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
  const directApiToken = `header.${Buffer.from(JSON.stringify({ aud: "https://api.openai.com/v1" })).toString("base64url")}.signature`;
  // SAFETY: registerSubscriptionCli only calls getAuth on the runtime.
  registerSubscriptionCli(async () => ({ getAuth: async (provider: string) => ({
    source: "OAuth", auth: { apiKey: provider === "openai-codex" ? token : directApiToken },
  }) }) as any);
  const context = await createWorkspaceSecretContext("openai-hosts-test");
  for (const host of ["chatgpt.com", "api.openai.com"]) {
    // SAFETY: The workspace secret context returns a rewritten Request for these matched hosts.
    const request = await context.hooks.onRequest!(new Request(`https://${host}/v1/responses`, { headers: { authorization: "Bearer agents-in-the-cloud-subscription-codex-access", "chatgpt-account-id": "agents-in-the-cloud-subscription-codex-account" } })) as Request;
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(request.headers.get("chatgpt-account-id")).toBe("account-123");
  }
  for (const host of ["auth.openai.com", "other.openai.com", "api.openai.com.example.com"]) {
    await expect(context.hooks.onRequest!(new Request(`https://${host}/`, { headers: { authorization: "Bearer agents-in-the-cloud-subscription-codex-access" } }))).rejects.toThrow("not allowed for host");
  }
  forgetSubscriptionInference("openai-codex");
  await context.hooks.onResponse!(new Response("ok"), new Request("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
  expect(providersInLastInferenceWindow()).toContain("openai-codex");
  forgetSubscriptionInference("openai-codex");
});

test("a nested installation's Pi gets subscription placeholders the parent's proxy keeps current", async () => {
  const codexToken = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
  // SAFETY: registerSubscriptionCli only calls getAuth on the runtime.
  registerSubscriptionCli(async () => ({ getAuth: async (provider: string) => ({ source: "OAuth", auth: { apiKey: provider === "anthropic" ? "sk-ant-oat01-real" : codexToken } }) }) as any);
  const seeded = seededPiAuth({
    anthropic: { type: "oauth", access: "sk-ant-oat01-real", refresh: "real-refresh", expires: 1 },
    "openai-codex": { type: "oauth", access: codexToken, refresh: "real-refresh", expires: 1, accountId: "account-123" },
    xai: { type: "oauth", access: "xai-access", refresh: "xai-refresh", expires: 1 },
    openai: { type: "api_key", key: "sk-openai" },
  });
  expect(seeded).toEqual({
    anthropic: { type: "oauth", access: expect.stringContaining("sk-ant-oat"), refresh: "", expires: 4070908800000 },
    "openai-codex": { type: "oauth", access: expect.any(String), refresh: "", expires: 4070908800000, accountId: "agents-in-the-cloud-subscription-codex-account" },
    xai: { type: "oauth", access: "xai-access", refresh: "xai-refresh", expires: 1 },
    openai: { type: "api_key", key: "sk-openai" },
  });
  // SAFETY: The equality check above proves both subscriptions carry string access tokens.
  const { anthropic, "openai-codex": codex } = seeded as Record<"anthropic" | "openai-codex", { access: string }>;

  const context = await createWorkspaceSecretContext("nested-pi-seed-test");
  // SAFETY: The workspace secret context always returns a rewritten Request for matched hosts.
  const anthropicRequest = await context.hooks.onRequest!(new Request("https://api.anthropic.com/v1/messages", { headers: { authorization: `Bearer ${anthropic.access}` } })) as Request;
  expect(anthropicRequest.headers.get("authorization")).toBe("Bearer sk-ant-oat01-real");
  // SAFETY: The workspace secret context always returns a rewritten Request for matched hosts.
  const codexRequest = await context.hooks.onRequest!(new Request("https://chatgpt.com/backend-api/codex/responses", { headers: { authorization: `Bearer ${codex.access}`, "chatgpt-account-id": codexAccountId(codex.access) } })) as Request;
  expect(codexRequest.headers.get("authorization")).toBe(`Bearer ${codexToken}`);
  expect(codexRequest.headers.get("chatgpt-account-id")).toBe("account-123");
});
