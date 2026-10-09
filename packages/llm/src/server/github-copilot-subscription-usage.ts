import { Type } from "typebox";
import { fetchSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";

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
  quota_reset_at: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 8640000000000 }), Type.Null()])),
});
const payloadSchema = Type.Object({
  copilot_plan: Type.Optional(Type.String()),
  quota_reset_date: dateSchema,
  quota_reset_date_utc: dateSchema,
  limited_user_reset_date: dateSchema,
  token_based_billing: Type.Optional(Type.Boolean()),
  quota_snapshots: Type.Object({
    premium_interactions: Type.Optional(Type.Union([quotaSchema, Type.Null()])),
    chat: Type.Optional(Type.Union([quotaSchema, Type.Null()])),
  }),
});

/** GitHub resets monthly quotas at the first of the month, 00:00 UTC:
 * https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests
 * A non-calendar reset still gets a countdown, but cannot establish a pacing start. */
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
  }, payloadSchema, { ...messages, unavailable: (status) => status === 403 ? messages.rejected : messages.unavailable(status) }, fetcher);
  const accountReset = payload.quota_reset_date_utc ?? payload.quota_reset_date ?? payload.limited_user_reset_date;
  const windows: SubscriptionUsage["windows"] = [];
  let limitReached = false;
  for (const [feature, label, kind] of [["premium_interactions", "Premium requests", "primary"], ["chat", "Chat", "secondary"]] as const) {
    const quota = payload.quota_snapshots[feature];
    // Unlimited allowances have no meaningful exhaustion percentage.
    if (!quota || quota.unlimited) continue;
    const entitlement = quota.entitlement === undefined ? undefined : Number(quota.entitlement);
    // VS Code also omits zero-entitlement categories; -1 denotes unlimited.
    if (entitlement === 0 || entitlement === -1) continue;
    if (entitlement !== undefined && (!Number.isFinite(entitlement) || entitlement < 0)) throw new SubscriptionUsageError(messages.unrecognized);
    const remainingCount = quota.quota_remaining ?? quota.remaining;
    const remaining = quota.percent_remaining ?? (entitlement && remainingCount !== undefined ? Number(remainingCount) / entitlement * 100 : entitlement && quota.credits_used !== undefined ? 100 - Number(quota.credits_used) / entitlement * 100 : undefined);
    if (remaining === undefined || !Number.isFinite(remaining)) throw new SubscriptionUsageError(messages.unrecognized);
    // Per-quota epoch seconds take priority over account-level dates, as in VS Code.
    const reset = quota.quota_reset_at != null ? new Date(quota.quota_reset_at * 1000) : parseReset(accountReset, messages.unrecognized);
    const usedPercent = Math.max(0, Math.min(100, 100 - remaining));
    if (usedPercent >= 100 && !quota.overage_permitted) limitReached = true;
    windows.push({ limitName: feature === "premium_interactions" && payload.token_based_billing ? "AI credits" : label, meteredFeature: feature, kind, usedPercent, durationSeconds: monthlyDurationSeconds(reset), resetsAt: reset?.toISOString() ?? null });
  }
  return {
    plan: payload.copilot_plan ?? null, checkedAt: new Date().toISOString(),
    allowed: null, limitReached, windows,
  };
}
