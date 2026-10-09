import { Type } from "typebox";
import { fetchSubscriptionUsageJson, subscriptionUsageMessages, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";

const quotaSchema = Type.Object({
  unlimited: Type.Optional(Type.Boolean()),
  percent_remaining: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  remaining: Type.Optional(Type.Number({ minimum: 0 })),
  entitlement: Type.Optional(Type.Number({ minimum: 0 })),
});
const payloadSchema = Type.Object({
  copilot_plan: Type.Optional(Type.String()),
  quota_reset_date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  quota_snapshots: Type.Object({
    premium_interactions: Type.Optional(Type.Union([quotaSchema, Type.Null()])),
    chat: Type.Optional(Type.Union([quotaSchema, Type.Null()])),
  }),
});

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
  const reset = payload.quota_reset_date ? new Date(payload.quota_reset_date) : null;
  if (reset && !Number.isFinite(reset.getTime())) throw new SubscriptionUsageError(messages.unrecognized);
  const windows: SubscriptionUsage["windows"] = [];
  for (const [feature, label, kind] of [["premium_interactions", "Premium requests", "primary"], ["chat", "Chat", "secondary"]] as const) {
    const quota = payload.quota_snapshots[feature];
    // Unlimited allowances have no meaningful exhaustion percentage.
    if (!quota || quota.unlimited) continue;
    const remaining = quota.percent_remaining ?? (quota.entitlement !== undefined && quota.entitlement > 0 && quota.remaining !== undefined ? quota.remaining / quota.entitlement * 100 : undefined);
    if (remaining === undefined) throw new SubscriptionUsageError(messages.unrecognized);
    windows.push({ limitName: label, meteredFeature: feature, kind, usedPercent: Math.max(0, Math.min(100, 100 - remaining)), durationSeconds: null, resetsAt: reset?.toISOString() ?? null });
  }
  return {
    plan: payload.copilot_plan ?? null, checkedAt: new Date().toISOString(),
    allowed: null, limitReached: windows.some((window) => window.usedPercent >= 100), windows,
  };
}
