import { Type } from "typebox";
import { fetchSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage, type ReportedAllowance } from "./subscription-usage.ts";

const countSchema = Type.Union([Type.Number(), Type.String({ pattern: "^-?\\d+(?:\\.\\d+)?$" })]);
const dateSchema = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const quotaSchema = Type.Object({
  unlimited: Type.Optional(Type.Boolean()),
  percent_remaining: Type.Optional(Type.Number()),
  remaining: Type.Optional(countSchema),
  quota_remaining: Type.Optional(countSchema),
  credits_used: Type.Optional(countSchema),
  entitlement: Type.Optional(countSchema),
  overage_permitted: Type.Optional(Type.Boolean()),
  overage_count: Type.Optional(countSchema),
  quota_id: Type.Optional(Type.String()),
  quota_reset_at: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 8640000000000 }), Type.Null()])),
});
const payloadSchema = Type.Object({
  copilot_plan: Type.Optional(Type.String()),
  access_type_sku: Type.Optional(Type.String()),
  quota_reset_date: dateSchema,
  quota_reset_date_utc: dateSchema,
  limited_user_reset_date: dateSchema,
  token_based_billing: Type.Optional(Type.Boolean()),
  quota_snapshots: Type.Optional(Type.Object({
    premium_interactions: Type.Optional(Type.Union([quotaSchema, Type.Null()])),
    chat: Type.Optional(Type.Union([quotaSchema, Type.Null()])),
    completions: Type.Optional(Type.Union([quotaSchema, Type.Null()])),
    premium_models: Type.Optional(Type.Union([quotaSchema, Type.Null()])),
  })),
});

/** Infer a calendar month for pacing only; the endpoint reports no period start.
 * Monthly policy: https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests
 * Non-calendar resets still get a countdown, but cannot establish a pacing start. */
function monthlyDurationSeconds(reset: Date | null): number | null {
  if (!reset || reset.getUTCDate() !== 1 || reset.getUTCHours() !== 0 || reset.getUTCMinutes() !== 0 || reset.getUTCSeconds() !== 0 || reset.getUTCMilliseconds() !== 0) return null;
  const start = new Date(reset);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return (reset.getTime() - start.getTime()) / 1000;
}

function parseReset(value: string | undefined | null, invalid: string): Date | null {
  if (value == null) return null;
  // Date-only values are UTC. Reject timezone-less timestamps rather than using host time.
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new SubscriptionUsageError(invalid);
  const calendarDate = value.slice(0, 10);
  const day = new Date(`${calendarDate}T00:00:00Z`);
  // JavaScript rolls e.g. February 30 into March, including in full timestamps.
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== calendarDate) throw new SubscriptionUsageError(invalid);
  const reset = new Date(value);
  if (!Number.isFinite(reset.getTime())) throw new SubscriptionUsageError(invalid);
  return reset;
}

/** GitHub's internal Copilot endpoint, also used by PiClaw. Requires the GitHub
 * OAuth token stored as `refresh`, not Pi's resolved Copilot inference token. */
export async function fetchGitHubCopilotSubscriptionUsage(githubToken: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  const messages = subscriptionUsageMessages("GitHub Copilot");
  const payload = await fetchSubscriptionUsageJson("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `token ${githubToken}`, Accept: "application/json",
      "Editor-Version": "vscode/1.96.2", "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01",
    },
  }, payloadSchema, { ...messages, unavailable: (status) => status === 403 ? "GitHub denied the usage check (HTTP 403). Check your account access or policy." : status === 429 ? "GitHub rate-limited usage checks (HTTP 429). Try again later." : messages.unavailable(status) }, fetcher);
  const accountReset = payload.quota_reset_date_utc ?? payload.quota_reset_date ?? payload.limited_user_reset_date;
  const windows: SubscriptionUsage["windows"] = [];
  const allowances: ReportedAllowance[] = [];
  const snapshots = payload.quota_snapshots;
  const free = payload.copilot_plan === "free" || payload.access_type_sku === "free_limited_copilot";
  const primary = free ? "chat" : snapshots?.premium_models ? "premium_models" : "premium_interactions";
  const premiumLabel = payload.token_based_billing === true ? "AI credits" : payload.token_based_billing === false ? "Premium requests" : "Premium allowance";
  for (const [feature, label] of [["premium_models", premiumLabel], ["premium_interactions", premiumLabel], ["chat", "Chat requests"], ["completions", "Code completions"]] as const) {
    const quota = snapshots?.[feature];
    if (!quota) continue;
    const entitlement = quota.entitlement === undefined ? undefined : Number(quota.entitlement);
    if (entitlement !== undefined && (!Number.isFinite(entitlement) || (entitlement < 0 && entitlement !== -1))) throw new SubscriptionUsageError(messages.unrecognized);
    const remainingCount = quota.quota_remaining ?? quota.remaining;
    const remainingQuantity = remainingCount === undefined ? null : Number(remainingCount);
    let remaining = quota.percent_remaining;
    if (remaining === undefined && entitlement !== undefined && entitlement > 0) {
      if (remainingQuantity !== null) remaining = remainingQuantity / entitlement * 100;
      else if (quota.credits_used !== undefined) remaining = 100 - Number(quota.credits_used) / entitlement * 100;
    }
    const overageCount = quota.overage_count === undefined ? null : Number(quota.overage_count);
    if ((remaining !== undefined && !Number.isFinite(remaining)) || (remainingQuantity !== null && !Number.isFinite(remainingQuantity)) || (overageCount !== null && (!Number.isFinite(overageCount) || overageCount < 0))) throw new SubscriptionUsageError(messages.unrecognized);
    // Per-quota epoch seconds take priority over account-level dates, as in VS Code.
    const reset = quota.quota_reset_at != null ? new Date(quota.quota_reset_at * 1000) : parseReset(accountReset, messages.unrecognized);
    const selected = feature === primary;
    const displayLabel = feature === "premium_interactions" && primary === "premium_models" ? "Premium interactions" : label;
    const unlimited = quota.unlimited === true || entitlement === -1;
    allowances.push({
      quotaId: feature, sourceQuotaId: quota.quota_id ?? null, label: displayLabel,
      unit: feature === "chat" ? "requests" : feature === "completions" ? "completions" : payload.token_based_billing === true ? "credits" : payload.token_based_billing === false ? "requests" : "unknown",
      selected, entitlement: entitlement ?? null, remaining: remainingQuantity,
      remainingPercent: remaining === undefined ? null : Math.max(0, Math.min(100, remaining)),
      remainingPercentSource: quota.percent_remaining !== undefined ? "reported" : remaining === undefined ? "unknown" : "quantity-estimate",
      unlimited, overageCount, overagePermitted: quota.overage_permitted ?? null,
      resetsAt: reset?.toISOString() ?? null,
    });
    // Only the account-appropriate allowance drives pacing; alternative categories
    // remain separate observations and are never added to its consumption.
    if (!selected || unlimited || entitlement === 0 || remaining === undefined) continue;
    windows.push({ periodBasis: "calendar-month-estimate", limitName: displayLabel, meteredFeature: feature, kind: "primary", usedPercent: Math.max(0, Math.min(100, 100 - remaining)), durationSeconds: monthlyDurationSeconds(reset), resetsAt: reset?.toISOString() ?? null });
  }
  return {
    plan: payload.copilot_plan ?? null, checkedAt: new Date().toISOString(),
    allowed: null, limitReached: null, allowances, windows,
  };
}
