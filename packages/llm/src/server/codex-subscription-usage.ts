import { fetchSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";
import { codexTokenClaims } from "./codex-token.ts";
import { Type, type Static } from "typebox";

const claimsSchema = Type.Object({ "https://api.openai.com/auth": Type.Optional(Type.Object({ chatgpt_account_id: Type.Optional(Type.String({ minLength: 1 })) })) });
const windowSchema = Type.Object({
  used_percent: Type.Number({ minimum: 0, maximum: 100 }),
  limit_window_seconds: Type.Integer({ minimum: 1 }),
  reset_at: Type.Integer({ minimum: 0, maximum: 8640000000000 }),
});
const limitsSchema = Type.Object({
  allowed: Type.Boolean(),
  limit_reached: Type.Boolean(),
  primary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
  secondary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
});
const payloadSchema = Type.Object({
  plan_type: Type.String(),
  credits: Type.Optional(Type.Union([Type.Object({
    unlimited: Type.Boolean(),
    balance: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }), Type.Null()])),
  rate_limit_reset_credits: Type.Optional(Type.Union([Type.Object({
    available_count: Type.Integer({ minimum: 0 }),
  }), Type.Null()])),
  chatpass: Type.Optional(Type.Union([Type.Object({ windows: Type.Array(windowSchema) }), Type.Null()])),
  rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  code_review_rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  additional_rate_limits: Type.Optional(Type.Union([Type.Array(Type.Object({
    limit_name: Type.String(), metered_feature: Type.String(),
    rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  })), Type.Null()])),
});

export async function fetchCodexSubscriptionUsage(accessToken: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  let claims: Static<typeof claimsSchema>;
  try {
    claims = codexTokenClaims(accessToken, claimsSchema);
  } catch {
    throw new SubscriptionUsageError("OpenAI credentials are invalid. Reconnect OpenAI Codex.");
  }
  const headers = new Headers({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" });
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (accountId) headers.set("ChatGPT-Account-Id", accountId);
  return normalizeUsage(await fetchSubscriptionUsageJson("https://chatgpt.com/backend-api/wham/usage", { headers }, payloadSchema, subscriptionUsageMessages("OpenAI", "OpenAI Codex"), fetcher));
}

function normalizeUsage(payload: Static<typeof payloadSchema>): SubscriptionUsage {
  const limits = payload.rate_limit;
  const usage: SubscriptionUsage = {
    plan: payload.plan_type,
    checkedAt: new Date().toISOString(),
    allowed: limits?.allowed ?? null,
    limitReached: limits?.limit_reached ?? null,
    windows: [
      { limit_name: "Codex", metered_feature: null, rate_limit: limits },
      ...(payload.code_review_rate_limit ? [{ limit_name: "Code review", metered_feature: "code_review", rate_limit: payload.code_review_rate_limit }] : []),
      ...payload.additional_rate_limits ?? [],
    ].flatMap((group) => (["primary", "secondary"] as const).flatMap((kind) => {
      const window = group.rate_limit?.[`${kind}_window`];
      return window ? [{ limitName: group.limit_name, meteredFeature: group.metered_feature, kind, usedPercent: window.used_percent, durationSeconds: window.limit_window_seconds, resetsAt: new Date(window.reset_at * 1000).toISOString() }] : [];
    })).concat((payload.chatpass?.windows ?? []).map((window) => ({
      limitName: "Chatpass", meteredFeature: "chatpass", kind: "primary" as const,
      usedPercent: window.used_percent, durationSeconds: window.limit_window_seconds,
      resetsAt: new Date(window.reset_at * 1000).toISOString(),
    }))),
  };
  if (payload.credits) usage.credits = {
    unlimited: payload.credits.unlimited,
    balance: payload.credits.balance ?? null,
  };
  if (payload.rate_limit_reset_credits) usage.resets = {
    available: payload.rate_limit_reset_credits.available_count,
  };
  return usage;
}
