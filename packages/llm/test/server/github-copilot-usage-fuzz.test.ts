import { expect, test } from "bun:test";
import { fetchGitHubCopilotSubscriptionUsage } from "../../src/server/github-copilot-subscription-usage.ts";
import { SubscriptionUsageError } from "../../src/server/subscription-usage.ts";
import { estimatedTimeToHitLimitSeconds, usageWindowTiming } from "../../src/server/usage-window.ts";

/** Fixed seeds make every generated failure reproducible in CI. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}

interface GeneratedQuota {
  entitlement: number | string;
  percent_remaining?: number;
  remaining?: number;
  quota_remaining?: string;
  credits_used?: number;
  quota_reset_at?: number;
}

function close(actual: number, expected: number) {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-7, Math.abs(expected) * 1e-10));
}

test("seed 0xc0ffee: 10,000 Copilot quota encodings preserve calendar pacing and exhaustion", async () => {
  const next = random(0xc0ffee);
  for (let sample = 0; sample < 10_000; sample++) {
    const year = 1990 + Math.floor(next() * 150);
    const month = Math.floor(next() * 12);
    const start = Date.UTC(year, month, 1);
    const reset = Date.UTC(year, month + 1, 1);
    const seconds = (reset - start) / 1000;
    const entitlement = 1 + Math.floor(next() * 100_000);
    const usedFraction = next();
    const remainingCount = entitlement * (1 - usedFraction);
    const percentRemaining = 100 * (1 - usedFraction);
    const quota: GeneratedQuota = { entitlement: sample % 2 ? String(entitlement) : entitlement };
    switch (sample % 5) {
      case 0: quota.percent_remaining = percentRemaining; quota.remaining = 0; break;
      case 1: quota.remaining = remainingCount; break;
      case 2: quota.quota_remaining = String(remainingCount); quota.remaining = 0; break;
      case 3: quota.credits_used = entitlement * usedFraction; break;
      case 4: quota.percent_remaining = percentRemaining; quota.quota_reset_at = reset / 1000; break;
    }
    const payload = { quota_reset_date: new Date(reset).toISOString().slice(0, 10), quota_snapshots: { premium_interactions: quota } };
    const usage = await fetchGitHubCopilotSubscriptionUsage("test-token", async () => Response.json(payload));
    const reported = usage.windows[0]!;
    expect(reported.durationSeconds).toBe(seconds);
    expect(reported.resetsAt).toBe(new Date(reset).toISOString());
    close(reported.usedPercent, usedFraction * 100);
    expect(usage.limitReached).toBe(false);
    // Include instants before start and after reset, not only active windows.
    const at = new Date(start + Math.floor((next() * 1.4 - 0.2) * (reset - start)));
    const elapsedSeconds = (at.getTime() - start) / 1000;
    const elapsedFraction = elapsedSeconds / seconds;
    const timing = usageWindowTiming(reported, at);
    expect(timing.startsAt).toBe(new Date(start).toISOString());
    close(timing.elapsedPercent!, Math.max(0, Math.min(100, elapsedFraction * 100)));
    const forecast = estimatedTimeToHitLimitSeconds({ reported, timing });
    if (elapsedFraction < 0 || elapsedFraction >= 1) {
      expect(timing.state).toBe(elapsedFraction < 0 ? "not-started" : "reset-due");
      expect(timing.paceDifferenceSeconds).toBeNull();
      expect(forecast).toBe(Infinity);
    } else {
      expect(timing.state).toBe("active");
      close(timing.paceDifferencePoints!, (usedFraction - elapsedFraction) * 100);
      close(timing.paceDifferenceSeconds!, usedFraction * seconds - elapsedSeconds);
      if (usedFraction <= elapsedFraction || elapsedFraction === 0) expect(forecast).toBe(Infinity);
      else close(forecast, elapsedSeconds / usedFraction - elapsedSeconds);
    }
  }
});

test("seed 0xdecafbad: 2,000 malformed quota mutations are safe usage errors", async () => {
  const next = random(0xdecafbad);
  const mutations: unknown[] = [undefined, null, true, false, [], {}, "NaN", "Infinity", "", " ", "test-token", "1e999", "9".repeat(400)];
  for (let sample = 0; sample < 2000; sample++) {
    const value = mutations[Math.floor(next() * mutations.length)];
    const field = ["percent_remaining", "entitlement", "quota_remaining", "credits_used", "quota_reset_at"][sample % 5]!;
    // Fields other than the mutated count still describe a finite, metered quota.
    const quota = field === "percent_remaining" ? { percent_remaining: value } : { entitlement: 100, [field]: value };
    try {
      await fetchGitHubCopilotSubscriptionUsage("test-token", async () => Response.json({ quota_reset_date: "2026-11-01", quota_snapshots: { premium_interactions: quota } }));
      throw new Error(`Mutation unexpectedly accepted: ${field}=${JSON.stringify(value)}`);
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionUsageError);
      if (!(error instanceof SubscriptionUsageError)) throw error;
      expect(error.message).not.toContain("test-token");
    }
  }
});

test("calendar validation rejects rolled-over dates in both timestamp and date-only fields", async () => {
  for (let year = 2020; year < 2050; year++) {
    for (const date of [`${year}-02-30`, `${year}-04-31`, `${year}-06-31`, `${year}-11-31`]) {
      for (const value of [date, `${date}T00:00:00Z`, `${date}T12:00:00+02:00`]) {
        await expect(fetchGitHubCopilotSubscriptionUsage("test-token", async () => Response.json({ quota_reset_date_utc: value, quota_snapshots: { chat: { percent_remaining: 50 } } }))).rejects.toBeInstanceOf(SubscriptionUsageError);
      }
    }
  }
});
