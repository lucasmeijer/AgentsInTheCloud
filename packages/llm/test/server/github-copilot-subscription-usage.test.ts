import { expect, test } from "bun:test";
import { fetchGitHubCopilotSubscriptionUsage } from "../../src/server/github-copilot-subscription-usage.ts";
import { usageWindowTiming, selectPacingWindow, estimatedTimeToHitLimitSeconds } from "../../src/server/usage-window.ts";

function payload() {
  return { copilot_plan: "individual", token_based_billing: false, quota_reset_date: "2026-11-01", quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 210, percent_remaining: 70 },
    chat: { entitlement: 500, remaining: 400 },
  } };
}

test("reads Copilot quotas using GitHub's token and editor headers", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("github-oauth", async (url, init) => {
    expect(url).toBe("https://api.github.com/copilot_internal/user");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("token github-oauth");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("editor-version")).toBe("vscode/1.96.2");
    expect(headers.get("editor-plugin-version")).toBe("copilot-chat/0.26.7");
    expect(headers.get("user-agent")).toBe("GitHubCopilotChat/0.26.7");
    expect(headers.get("x-github-api-version")).toBe("2025-04-01");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json(payload());
  });
  expect(usage.plan).toBe("individual");
  expect(usage.limitReached).toBeNull();
  expect(usage.windows).toEqual([
    { periodBasis: "calendar-month-estimate", limitName: "Premium requests", meteredFeature: "premium_interactions", kind: "primary", usedPercent: 30, durationSeconds: 31 * 86400, resetsAt: "2026-11-01T00:00:00.000Z" },
  ]);
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "chat")?.remainingPercent).toBe(80);
  const windows = usage.windows.map(reported => ({ reported, timing: usageWindowTiming(reported, new Date("2026-10-16T12:00:00Z")) }));
  expect(windows[0]!.timing).toEqual({ state: "active", startsAt: "2026-10-01T00:00:00.000Z", elapsedPercent: 50, paceDifferencePoints: -20, paceDifferenceSeconds: -0.2 * 31 * 86400 });
  expect(selectPacingWindow(windows)).toBe(windows[0]);
});

test("prefers percent_remaining over entitlement arithmetic", async () => {
  const data = payload();
  data.quota_snapshots.premium_interactions.remaining = 100;
  expect((await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json(data))).windows[0]!.usedPercent).toBe(30);
});

test("unlimited chat is preserved without a pacing window and exhaustion is separate from access", async () => {
  const data = payload();
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...data, quota_snapshots: {
    premium_interactions: { percent_remaining: 0 }, chat: { unlimited: true, entitlement: 0 },
  } }));
  expect(usage.windows).toHaveLength(1);
  expect(usage.limitReached).toBeNull();
  expect(usage.allowances?.find((allowance) => allowance.selected)?.remainingPercent).toBe(0);
});

test("missing reset timing retains quotas without inventing pacing", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 40 } } }));
  expect(usage.windows[0]!.resetsAt).toBeNull();
  expect(usage.windows[0]!.usedPercent).toBe(60);
  expect(usage.plan).toBeNull();
});

test("empty snapshots are recognised without fabricating usage", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: {} }));
  expect(usage.windows).toEqual([]);
});

for (const status of [401, 403, 429, 500]) {
  test(`Copilot HTTP ${status} becomes a usage error`, async () => {
    await expect(fetchGitHubCopilotSubscriptionUsage("secret", async () => new Response("secret", { status }))).rejects.toThrow(status === 401 ? "Reconnect GitHub Copilot" : `HTTP ${status}`);
  });
}

test("network failures do not expose credentials", async () => {
  await expect(fetchGitHubCopilotSubscriptionUsage("secret", async () => { throw new Error("secret"); })).rejects.toThrow("Could not reach GitHub Copilot");
});

test("invalid JSON is a usage error", async () => {
  await expect(fetchGitHubCopilotSubscriptionUsage("token", async () => new Response("not json"))).rejects.toThrow("invalid usage response");
});

for (const data of [ { ...payload(), quota_reset_date: "bad date" }, { quota_snapshots: { chat: { entitlement: "not a number" } } } ]) {
  test(`rejects unrecognised Copilot response ${JSON.stringify(data)}`, async () => {
    await expect(fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json(data))).rejects.toThrow("unrecognized usage response");
  });
}

for (const [reset, start, days] of [
  ["2026-03-01", "2026-02-01", 28],
  ["2028-03-01", "2028-02-01", 29],
  ["2026-05-01", "2026-04-01", 30],
  ["2027-01-01", "2026-12-01", 31],
] as const) {
  test(`calendar month ending ${reset} computes elapsed time, pace and exhaustion using ${days} days`, async () => {
    const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_reset_date_utc: `${reset}T00:00:00Z`, quota_snapshots: { premium_interactions: { percent_remaining: 25 } } }));
    const reported = usage.windows[0]!;
    expect(reported.durationSeconds).toBe(days * 86400);
    const at = new Date(new Date(start).getTime() + days / 2 * 86400_000);
    const timing = usageWindowTiming(reported, at);
    expect(timing.startsAt).toBe(`${start}T00:00:00.000Z`);
    expect(timing.elapsedPercent).toBe(50);
    expect(timing.paceDifferencePoints).toBe(25);
    expect(timing.paceDifferenceSeconds).toBe(days / 4 * 86400);
    expect(estimatedTimeToHitLimitSeconds({ reported, timing })).toBeCloseTo(days / 6 * 86400, 6);
    expect(usageWindowTiming(reported, new Date(start)).elapsedPercent).toBe(0);
    const due = usageWindowTiming(reported, new Date(reset));
    expect(due.state).toBe("reset-due");
    expect(due.elapsedPercent).toBe(100);
    expect(due.paceDifferenceSeconds).toBeNull();
    const notStarted = usageWindowTiming(reported, new Date(new Date(start).getTime() - 1));
    expect(notStarted.state).toBe("not-started");
    expect(notStarted.paceDifferenceSeconds).toBeNull();
  });
}

test("UTC reset date takes priority over the older date-only field", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date_utc: "2026-12-01T00:00:00Z" }));
  expect(usage.windows[0]!.resetsAt).toBe("2026-12-01T00:00:00.000Z");
  expect(usage.windows[0]!.durationSeconds).toBe(30 * 86400);
});

test("each quota's epoch-seconds reset overrides account dates independently", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date_utc: "2026-12-01T00:00:00Z", quota_snapshots: {
    premium_interactions: { percent_remaining: 25, quota_reset_at: Date.parse("2026-11-01T00:00:00Z") / 1000 },
    chat: { percent_remaining: 50, quota_reset_at: Date.parse("2026-10-15T13:00:00Z") / 1000 },
  } }));
  expect(usage.windows[0]!.resetsAt).toBe("2026-11-01T00:00:00.000Z");
  expect(usage.windows[0]!.durationSeconds).toBe(31 * 86400);
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "chat")?.resetsAt).toBe("2026-10-15T13:00:00.000Z");
  expect(usage.windows).toHaveLength(1);
});

test("offset timestamps resolve to UTC without daylight-saving or host-timezone shifts", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date_utc: "2026-10-31T20:00:00-04:00" }));
  expect(usage.windows[0]!.resetsAt).toBe("2026-11-01T00:00:00.000Z");
  expect(usage.windows[0]!.durationSeconds).toBe(31 * 86400);
});

for (const reset of ["2026-02-30", "2026-11-01T00:00:00"]) {
  test(`rejects ambiguous or invalid reset ${reset}`, async () => {
    await expect(fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_reset_date: reset }))).rejects.toThrow("unrecognized");
  });
}

test("current credit fields accept string entitlements and prefer quota_remaining over legacy remaining", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), token_based_billing: true, quota_snapshots: {
    premium_interactions: { entitlement: "300.00", quota_remaining: 210, remaining: 10 },
    chat: { entitlement: "100", credits_used: 25 },
  } }));
  expect(usage.windows[0]!.limitName).toBe("AI credits");
  expect(usage.windows[0]!.usedPercent).toBe(30);
  expect(usage.allowances?.find((allowance) => allowance.quotaId === "chat")?.remainingPercent).toBe(75);
  expect(usage.allowances?.[0]!.remainingPercentSource).toBe("quantity-estimate");
});

test("zero-entitlement and unlimited categories do not cause division by zero or false exhaustion", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_interactions: { entitlement: "0", percent_remaining: 0 }, chat: { entitlement: "-1", percent_remaining: 0 },
  } }));
  expect(usage.windows).toEqual([]);
  expect(usage.limitReached).toBeNull();
});

test("paid overage does not signal blocked access, but preserves allowance exhaustion", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_interactions: { percent_remaining: 0, overage_permitted: true },
  } }));
  expect(usage.limitReached).toBeNull();
  expect(usage.windows[0]!.usedPercent).toBe(100);
  const reported = usage.windows[0]!;
  expect(estimatedTimeToHitLimitSeconds({ reported, timing: usageWindowTiming(reported, new Date("2026-10-15")) })).toBe(0);
});

test("rounding and overage percentages stay within the displayed allowance range", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_interactions: { percent_remaining: -1 }, chat: { percent_remaining: 101 },
  } }));
  expect(usage.windows.map(window => window.usedPercent)).toEqual([100]);
  expect(usage.allowances?.map(allowance => allowance.remainingPercent)).toEqual([0, 100]);
});

test("free-plan reset date also supports calendar pacing", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ copilot_plan: "free", limited_user_reset_date: "2026-11-01", quota_snapshots: { chat: { entitlement: 50, remaining: 25 } } }));
  expect(usage.windows[0]!.durationSeconds).toBe(31 * 86400);
  expect(usage.windows[0]!.usedPercent).toBe(50);
});

test("paid accounts prefer premium_models without merging premium_interactions or chat", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_models: { entitlement: 300, remaining: 180, percent_remaining: 60, quota_id: "premium" },
    premium_interactions: { entitlement: 300, remaining: 30, percent_remaining: 10 },
    chat: { entitlement: -1, remaining: -1, unlimited: true, percent_remaining: 100 },
    completions: { entitlement: -1, unlimited: true },
  } }));
  expect(usage.windows).toHaveLength(1);
  expect(usage.windows[0]!.meteredFeature).toBe("premium_models");
  expect(usage.windows[0]!.usedPercent).toBe(40);
  expect(usage.allowances).toHaveLength(4);
  expect(usage.allowances?.filter(allowance => allowance.selected).map(allowance => allowance.quotaId)).toEqual(["premium_models"]);
  expect(usage.allowances?.[0]!.sourceQuotaId).toBe("premium");
  expect(usage.allowances?.find(allowance => allowance.quotaId === "chat")?.unlimited).toBe(true);
  expect(usage.allowances?.find(allowance => allowance.quotaId === "completions")?.unlimited).toBe(true);
});

for (const classification of [{ copilot_plan: "free" }, { copilot_plan: "unknown", access_type_sku: "free_limited_copilot" }]) {
  test(`free classification ${JSON.stringify(classification)} selects chat independently of premium usage`, async () => {
    const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), ...classification, quota_snapshots: {
      chat: { entitlement: 50, remaining: 40, percent_remaining: 80 },
      premium_models: { entitlement: 300, percent_remaining: 0 },
    } }));
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]!.limitName).toBe("Chat requests");
    expect(usage.windows[0]!.usedPercent).toBe(20);
    expect(usage.allowances?.find(allowance => allowance.selected)?.quotaId).toBe("chat");
    expect(usage.allowed).toBeNull();
  });
}

test("unlimited primary allowance is a reported state, not zero usage or missing quota", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_models: { entitlement: "-1", remaining: -1, unlimited: true, percent_remaining: 100 },
  } }));
  expect(usage.windows).toEqual([]);
  expect(usage.allowances?.[0]).toMatchObject({ selected: true, unlimited: true, entitlement: -1, remaining: -1 });
});

test("rounded percentages never replace exact remaining amounts and overage is kept separate", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 179.875, percent_remaining: 60, overage_count: "0.0125", overage_permitted: true },
  } }));
  expect(usage.windows[0]!.usedPercent).toBe(40);
  expect(usage.allowances?.[0]).toMatchObject({ remaining: 179.875, remainingPercent: 60, remainingPercentSource: "reported", overageCount: 0.0125, overagePermitted: true, unit: "requests" });
});

for (const data of [{}, { quota_snapshots: { premium_interactions: {} } }, { quota_snapshots: { premium_interactions: { entitlement: 300, quota_reset_at: null } } }]) {
  test(`incomplete snapshot ${JSON.stringify(data)} stays unknown`, async () => {
    const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json(data));
    expect(usage.windows).toEqual([]);
    expect(usage.allowed).toBeNull();
    expect(usage.limitReached).toBeNull();
    if (usage.allowances?.length) expect(usage.allowances[0]!.remainingPercent).toBeNull();
  });
}

test("missing free chat does not silently substitute an exhausted premium bucket", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...payload(), copilot_plan: "free", quota_snapshots: { premium_interactions: { percent_remaining: 0 } } }));
  expect(usage.windows).toEqual([]);
  expect(usage.allowances?.some(allowance => allowance.selected)).toBe(false);
});

test("unknown billing generation uses a neutral label instead of inventing request or credit units", async () => {
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ quota_snapshots: { premium_models: { entitlement: 300, percent_remaining: 60 } } }));
  expect(usage.windows[0]!.limitName).toBe("Premium allowance");
  expect(usage.allowances?.[0]!.unit).toBe("unknown");
});
