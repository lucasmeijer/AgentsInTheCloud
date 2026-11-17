import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { fetchSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";

const count = Type.Union([Type.Number(), Type.String({ pattern: "^-?\\d+(?:\\.\\d+)?$" })]);
const quotaSchema = Type.Object({
  unlimited: Type.Optional(Type.Boolean()),
  entitlement: Type.Optional(count),
  remaining: Type.Optional(count),
  quota_remaining: Type.Optional(count),
  percent_remaining: Type.Optional(Type.Number()),
  has_quota: Type.Optional(Type.Boolean()),
  overage_permitted: Type.Optional(Type.Boolean()),
});
const quotaCounts = Type.Optional(Type.Union([Type.Object({ chat: Type.Optional(Type.Number()), completions: Type.Optional(Type.Number()) }), Type.Null()]));
const date = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const payloadSchema = Type.Object({
  copilot_plan: Type.Optional(Type.String()),
  token_based_billing: Type.Optional(Type.Boolean()),
  quota_reset_date: date,
  quota_reset_date_utc: date,
  quota_snapshots: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Union([quotaSchema, Type.Null()])), Type.Null()])),
  limited_user_quotas: quotaCounts,
  monthly_quotas: quotaCounts,
  limited_user_reset_date: date,
});
type Payload = Static<typeof payloadSchema>;
const signInSchema = Type.Object({ refresh: Type.String({ minLength: 1 }), enterpriseUrl: Type.Optional(Type.String()) });

type Allowance = { limitName: string; meteredFeature: string | null; unlimited: boolean; entitlement: number; remaining: number | null; usedPercent: number; overagePermitted: boolean | null };

function allowance(limitName: string, meteredFeature: string | null, quota: Static<typeof quotaSchema>): Allowance {
  const entitlement = Number(quota.entitlement ?? 0);
  const remaining = quota.quota_remaining ?? quota.remaining;
  const remainingCount = remaining === undefined ? null : Number(remaining);
  const remainingPercent = quota.has_quota === false ? 0 : quota.percent_remaining ?? (remainingCount !== null && entitlement > 0 ? remainingCount / entitlement * 100 : 100);
  return {
    limitName, meteredFeature, entitlement, remaining: remainingCount, overagePermitted: quota.overage_permitted ?? null,
    unlimited: quota.unlimited === true || entitlement < 0,
    usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
  };
}

function allowances(payload: Payload): Allowance[] {
  const snapshots = payload.quota_snapshots ?? {};
  const premium = snapshots.premium_models ?? snapshots.premium_interactions;
  const premiumName = payload.token_based_billing ? "AI credits" : "Premium requests";
  const reported = [
    ...premium ? [allowance(premiumName, null, premium)] : [],
    ...snapshots.chat ? [allowance("Chat", "chat", snapshots.chat)] : [],
    ...snapshots.completions ? [allowance("Completions", "completions", snapshots.completions)] : [],
  ];
  if (reported.length) return reported;
  const { limited_user_quotas: remaining, monthly_quotas: monthly } = payload;
  return (["chat", "completions"] as const).flatMap((feature) => {
    const entitlement = monthly?.[feature];
    if (entitlement === undefined) return [];
    return [allowance(feature === "chat" ? "Chat" : "Completions", feature, { entitlement, remaining: remaining?.[feature] ?? entitlement })];
  });
}

function monthBefore(reset: Date): Date {
  const start = new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, 1, reset.getUTCHours(), reset.getUTCMinutes(), reset.getUTCSeconds()));
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(reset.getUTCDate(), daysInMonth));
  return start;
}

function quantity(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function detail({ limitName, unlimited, entitlement, remaining, overagePermitted }: Allowance): { label: string; value: string } | [] {
  if (unlimited) return { label: limitName, value: "Unlimited" };
  if (remaining === null || entitlement <= 0) return [];
  if (remaining >= 0) return { label: limitName, value: `${quantity(remaining)} of ${quantity(entitlement)} left` };
  return { label: limitName, value: `${quantity(-remaining)} over${overagePermitted ? ", billed as extra usage" : ""}` };
}

/** GitHub's own editors read this endpoint. Not a public, versioned API.
 * It needs the GitHub sign-in token Pi keeps as `refresh`, not the short-lived Copilot token. */
export async function fetchGitHubCopilotSubscriptionUsage(credential: OAuthCredential, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  const messages = subscriptionUsageMessages("GitHub Copilot");
  const signIn: unknown = credential;
  if (!Value.Check(signInSchema, signIn)) throw new SubscriptionUsageError("GitHub Copilot credentials are unavailable. Reconnect GitHub Copilot.");
  const { refresh, enterpriseUrl } = signIn;
  const domain = enterpriseUrl ? new URL(enterpriseUrl.includes("://") ? enterpriseUrl : `https://${enterpriseUrl}`).hostname : "github.com";
  const payload = await fetchSubscriptionUsageJson(`https://api.${domain}/copilot_internal/user`, {
    headers: {
      Authorization: `token ${refresh}`, Accept: "application/json",
      "Editor-Version": "vscode/1.96.2", "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01",
    },
  }, payloadSchema, messages, fetcher);
  const resetValue = payload.quota_reset_date_utc ?? payload.quota_reset_date ?? payload.limited_user_reset_date;
  const reset = resetValue ? new Date(resetValue) : null;
  if (reset && !Number.isFinite(reset.getTime())) throw new SubscriptionUsageError(messages.unrecognized);
  const reported = allowances(payload);
  if (reported.some(({ entitlement, remaining, usedPercent }) => !Number.isFinite(entitlement) || (remaining !== null && !Number.isFinite(remaining)) || !Number.isFinite(usedPercent))) throw new SubscriptionUsageError(messages.unrecognized);
  return {
    plan: payload.copilot_plan ?? null,
    checkedAt: new Date().toISOString(),
    allowed: null,
    limitReached: null,
    windows: reset ? reported.filter(({ unlimited, entitlement }) => !unlimited && entitlement > 0).map(({ limitName, meteredFeature, usedPercent }) => ({
      limitName, meteredFeature, kind: "primary" as const, usedPercent,
      durationSeconds: Math.round((reset.getTime() - monthBefore(reset).getTime()) / 1000), resetsAt: reset.toISOString(),
    })) : [],
    details: reported.flatMap(detail),
  };
}
