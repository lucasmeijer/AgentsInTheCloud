import { expect, test } from "bun:test";
import { fetchGitHubCopilotSubscriptionUsage } from "../../src/server/github-copilot-subscription-usage.ts";
import { usageWindowTiming, selectPacingWindow } from "../../src/server/usage-window.ts";

function payload() {
  return { copilot_plan: "individual", quota_reset_date: "2026-11-01", quota_snapshots: {
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
  expect(usage.limitReached).toBe(false);
  expect(usage.windows).toEqual([
    { limitName: "Premium requests", meteredFeature: "premium_interactions", kind: "primary", usedPercent: 30, durationSeconds: null, resetsAt: "2026-11-01T00:00:00.000Z" },
    { limitName: "Chat", meteredFeature: "chat", kind: "secondary", usedPercent: 20, durationSeconds: null, resetsAt: "2026-11-01T00:00:00.000Z" },
  ]);
  const windows = usage.windows.map(reported => ({ reported, timing: usageWindowTiming(reported, new Date()) }));
  expect(windows[0]!.timing.state).toBe("unknown");
  expect(selectPacingWindow(windows)).toBeUndefined();
});

test("prefers percent_remaining over entitlement arithmetic", async () => {
  const data = payload();
  data.quota_snapshots.premium_interactions.remaining = 100;
  expect((await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json(data))).windows[0]!.usedPercent).toBe(30);
});

test("unlimited chat is omitted and exhausted premium requests are reported", async () => {
  const data = payload();
  const usage = await fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json({ ...data, quota_snapshots: {
    premium_interactions: { percent_remaining: 0 }, chat: { unlimited: true, entitlement: 0 },
  } }));
  expect(usage.windows).toHaveLength(1);
  expect(usage.limitReached).toBe(true);
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
    await expect(fetchGitHubCopilotSubscriptionUsage("secret", async () => new Response("secret", { status }))).rejects.toThrow(status === 401 || status === 403 ? "Reconnect GitHub Copilot" : `HTTP ${status}`);
  });
}

test("network failures do not expose credentials", async () => {
  await expect(fetchGitHubCopilotSubscriptionUsage("secret", async () => { throw new Error("secret"); })).rejects.toThrow("Could not reach GitHub Copilot");
});

test("invalid JSON is a usage error", async () => {
  await expect(fetchGitHubCopilotSubscriptionUsage("token", async () => new Response("not json"))).rejects.toThrow("invalid usage response");
});

for (const data of [ {}, { quota_snapshots: { premium_interactions: {} } }, { quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0 } } }, { ...payload(), quota_reset_date: "bad date" }, { quota_snapshots: { chat: { percent_remaining: 101 } } } ]) {
  test(`rejects unrecognised Copilot response ${JSON.stringify(data)}`, async () => {
    await expect(fetchGitHubCopilotSubscriptionUsage("token", async () => Response.json(data))).rejects.toThrow("unrecognized usage response");
  });
}
