import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { usesProviderSubscription } from "./subscription.ts";
import { codexTokenClaims } from "./codex-token.ts";
import type { Fetcher } from "./subscription-usage.ts";

type AccountRuntime = Pick<ModelRuntime, "getProviderAuthStatus" | "listCredentials" | "getAuth">;

const codexClaimsSchema = Type.Object({
  "https://api.openai.com/profile": Type.Object({ email: Type.String({ minLength: 1 }) }),
  "https://api.openai.com/auth": Type.Object({ chatgpt_plan_type: Type.Optional(Type.String({ minLength: 1 })) }),
});
const anthropicProfileSchema = Type.Object({
  account: Type.Object({ email: Type.String({ minLength: 1 }) }),
  organization: Type.Object({ name: Type.String(), organization_type: Type.String() }),
});
const emailSchema = Type.Object({ email: Type.String({ minLength: 1 }) });
const radiusContextSchema = Type.Object({ organization: Type.Object({ name: Type.String({ minLength: 1 }) }) });

function planLabel(plan: string): string {
  return plan.replace(/^claude_/, "").split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function codexAccountSummary(accessToken: string): string {
  const claims = codexTokenClaims(accessToken, codexClaimsSchema);
  const plan = claims["https://api.openai.com/auth"].chatgpt_plan_type;
  return [claims["https://api.openai.com/profile"].email, plan && planLabel(plan)].filter(Boolean).join(" · ");
}

export async function fetchAnthropicAccountSummary(accessToken: string, fetcher: Fetcher = fetch): Promise<string> {
  const response = await fetcher("https://api.anthropic.com/api/oauth/profile", {
    headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Anthropic profile is unavailable (HTTP ${response.status}).`);
  const { account, organization } = Value.Parse(anthropicProfileSchema, await response.json());
  const plan = planLabel(organization.organization_type);
  const shared = ["Team", "Enterprise"].includes(plan) ? organization.name : "";
  return [account.email, plan, shared].filter(Boolean).join(" · ");
}

export async function fetchXaiAccountSummary(accessToken: string, fetcher: Fetcher = fetch): Promise<string> {
  const response = await fetcher("https://auth.x.ai/oauth2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`xAI profile is unavailable (HTTP ${response.status}).`);
  return Value.Parse(emailSchema, await response.json()).email;
}

export async function fetchOpenAIAccountSummary(accessToken: string, fetcher: Fetcher = fetch): Promise<string> {
  const response = await fetcher("https://api.openai.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`OpenAI profile is unavailable (HTTP ${response.status}).`);
  return Value.Parse(emailSchema, await response.json()).email;
}

export async function fetchRadiusAccountSummary(accessToken: string, fetcher: Fetcher = fetch): Promise<string> {
  const response = await fetcher("https://radius.pi.dev/v1/context", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Radius context is unavailable (HTTP ${response.status}).`);
  return Value.Parse(radiusContextSchema, await response.json()).organization.name;
}

export function cachedAccountSummaries(fetchSummary: (accessToken: string) => Promise<string>, now = () => Date.now()) {
  let cached: { token: string; summary: Promise<string | undefined>; retryAt: number } | undefined;
  return (accessToken: string): Promise<string | undefined> => {
    if (cached?.token === accessToken && now() < cached.retryAt) return cached.summary;
    const entry = { token: accessToken, retryAt: Number.POSITIVE_INFINITY, summary: Promise.resolve<string | undefined>(undefined) };
    entry.summary = fetchSummary(accessToken).catch((error: Error) => {
      console.warn(`[providers] ${error.message}`);
      entry.retryAt = now() + 60_000;
      return undefined;
    });
    cached = entry;
    return entry.summary;
  };
}

const subscriptionAccountSummaries = new Map<string, (accessToken: string) => Promise<string | undefined>>([
  ["openai", cachedAccountSummaries((accessToken) => fetchOpenAIAccountSummary(accessToken))],
  ["openai-codex", async (accessToken) => codexAccountSummary(accessToken)],
  ["anthropic", cachedAccountSummaries((accessToken) => fetchAnthropicAccountSummary(accessToken))],
  ["xai", cachedAccountSummaries((accessToken) => fetchXaiAccountSummary(accessToken))],
  ["radius", cachedAccountSummaries((accessToken) => fetchRadiusAccountSummary(accessToken))],
]);

export async function providerAccountSummary(runtime: AccountRuntime, provider: string): Promise<string | undefined> {
  const status = runtime.getProviderAuthStatus(provider);
  if (!status.configured) return undefined;
  if (status.source !== "stored") return status.label ? `From ${status.label}` : undefined;
  if (!await usesProviderSubscription(runtime, provider)) return "API key";
  const accountSummary = subscriptionAccountSummaries.get(provider);
  if (!accountSummary) return "Subscription";
  const token = (await runtime.getAuth(provider, { signal: AbortSignal.timeout(10_000) }))?.auth.apiKey;
  if (!token) return undefined;
  return await accountSummary(token) ?? "Subscription";
}
