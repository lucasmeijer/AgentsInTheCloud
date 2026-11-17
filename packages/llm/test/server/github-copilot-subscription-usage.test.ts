import { expect, test } from "bun:test";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { JsonObject } from "@agents-in-the-cloud/core";
import { fetchGitHubCopilotSubscriptionUsage } from "../../src/server/github-copilot-subscription-usage.ts";

const credential: OAuthCredential = { type: "oauth", refresh: "github-token", access: "copilot-token", expires: 0 };
const usage = (payload: JsonObject, signIn = credential) => fetchGitHubCopilotSubscriptionUsage(signIn, async () => Response.json(payload));

const pro = {
  copilot_plan: "individual", quota_reset_date: "2026-11-01", quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
  quota_snapshots: {
    chat: { entitlement: 0, overage_count: 0, overage_permitted: false, percent_remaining: 100, quota_id: "chat", quota_remaining: 0, remaining: 0, unlimited: true },
    completions: { entitlement: 0, overage_count: 0, overage_permitted: false, percent_remaining: 100, quota_id: "completions", quota_remaining: 0, remaining: 0, unlimited: true },
    premium_interactions: { entitlement: 300, overage_count: 0, overage_permitted: true, percent_remaining: 70, quota_id: "premium_interactions", quota_remaining: 210, remaining: 210, unlimited: false },
  },
};

test("a paid plan paces premium requests over the calendar month and lists the unlimited allowances", async () => {
  const reported = await fetchGitHubCopilotSubscriptionUsage(credential, async (url, init) => {
    expect(url).toBe("https://api.github.com/copilot_internal/user");
    expect(new Headers(init.headers).get("authorization")).toBe("token github-token");
    return Response.json(pro);
  });
  expect(reported.plan).toBe("individual");
  expect(reported.limitReached).toBeNull();
  expect(reported.windows).toEqual([{ limitName: "Premium requests", meteredFeature: null, kind: "primary", usedPercent: 30, durationSeconds: 31 * 86400, resetsAt: "2026-11-01T00:00:00.000Z" }]);
  expect(reported.details).toEqual([
    { label: "Premium requests", value: "210 of 300 left" },
    { label: "Chat", value: "Unlimited" },
    { label: "Completions", value: "Unlimited" },
  ]);
});

test("token-billed accounts over their allowance show credits used past it", async () => {
  const reported = await usage({ ...pro, token_based_billing: true, quota_snapshots: {
    premium_interactions: { entitlement: 3000, quota_remaining: -739.5, remaining: -740, credits_used: 3739, percent_remaining: 0, has_quota: false, overage_permitted: true },
  } });
  expect(reported.windows.map(({ limitName, usedPercent }) => ({ limitName, usedPercent }))).toEqual([{ limitName: "AI credits", usedPercent: 100 }]);
  expect(reported.details).toEqual([{ label: "AI credits", value: "739.5 over, billed as extra usage" }]);
});

test("newer accounts report premium_models in place of premium_interactions", async () => {
  const reported = await usage({ ...pro, quota_snapshots: {
    premium_models: { entitlement: "300.00", quota_remaining: "180", percent_remaining: 60 },
    premium_interactions: { entitlement: 300, percent_remaining: 10 },
  } });
  expect(reported.windows.map(({ usedPercent }) => usedPercent)).toEqual([40]);
  expect(reported.details).toEqual([{ label: "Premium requests", value: "180 of 300 left" }]);
});

test("older Free accounts pace chat and completions to their own reset day", async () => {
  const reported = await usage({
    copilot_plan: "individual", access_type_sku: "free_limited_copilot", limited_user_reset_date: "2026-11-11",
    limited_user_quotas: { chat: 40, completions: 1500 }, monthly_quotas: { chat: 50, completions: 2000 },
  });
  expect(reported.windows).toEqual([
    { limitName: "Chat", meteredFeature: "chat", kind: "primary", usedPercent: 20, durationSeconds: 31 * 86400, resetsAt: "2026-11-11T00:00:00.000Z" },
    { limitName: "Completions", meteredFeature: "completions", kind: "primary", usedPercent: 25, durationSeconds: 31 * 86400, resetsAt: "2026-11-11T00:00:00.000Z" },
  ]);
  expect(reported.details).toEqual([{ label: "Chat", value: "40 of 50 left" }, { label: "Completions", value: "1,500 of 2,000 left" }]);
});

test("month lengths come from the month before the reset, clamped to its last day", async () => {
  for (const [reset, days] of [["2026-03-01", 28], ["2028-03-01", 29], ["2026-03-31", 31], ["2026-03-30", 30]] as const) {
    expect((await usage({ ...pro, quota_reset_date_utc: reset })).windows[0]!.durationSeconds).toBe(days * 86400);
  }
});

test("without a reset date the counts still show, but nothing is paced", async () => {
  const reported = await usage({ quota_snapshots: pro.quota_snapshots });
  expect(reported.windows).toEqual([]);
  expect(reported.details?.[0]).toEqual({ label: "Premium requests", value: "210 of 300 left" });
});

test("enterprise sign-ins ask their own GitHub server", async () => {
  await fetchGitHubCopilotSubscriptionUsage({ ...credential, enterpriseUrl: "https://octo.ghe.com/" }, async (url) => {
    expect(url).toBe("https://api.octo.ghe.com/copilot_internal/user");
    return Response.json(pro);
  });
});

test("rejected GitHub credentials ask for a reconnect", async () => {
  await expect(fetchGitHubCopilotSubscriptionUsage(credential, async () => new Response("", { status: 401 }))).rejects.toThrow("Reconnect GitHub Copilot");
});

test("unrecognized Copilot responses are errors", async () => {
  await expect(usage({ ...pro, quota_reset_date_utc: "soon" })).rejects.toThrow("unrecognized");
  await expect(usage({ quota_snapshots: { chat: { entitlement: "lots" } } })).rejects.toThrow("unrecognized");
});
