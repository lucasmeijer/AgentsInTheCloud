import type { SubscriptionUsage } from "./subscription-usage.ts";

export type UsageWindowTiming = {
  state: "unknown";
  startsAt: null;
  elapsedPercent: null;
  paceDifferencePoints: null;
  paceDifferenceSeconds: null;
} | {
  /** Inferred from the provider's reset timestamp minus its window duration. */
  startsAt: string;
  elapsedPercent: number;
  state: "not-started" | "active" | "reset-due";
  /** Usage minus elapsed time, in percentage points. Not meaningful outside the active window. */
  paceDifferencePoints: number | null;
  /** Signed distance along the linear allowance schedule; positive means consumption is ahead. */
  paceDifferenceSeconds: number | null;
}

/** A linear pacing reference, not a prediction of provider allowance consumption. */
export function usageWindowTiming(window: SubscriptionUsage["windows"][number], at: Date): UsageWindowTiming {
  if (window.resetsAt === null || window.durationSeconds === null) return { state: "unknown", startsAt: null, elapsedPercent: null, paceDifferencePoints: null, paceDifferenceSeconds: null };
  const reset = new Date(window.resetsAt).getTime();
  const duration = window.durationSeconds * 1000;
  const start = reset - duration;
  const elapsedPercent = Math.max(0, Math.min(100, (at.getTime() - start) / duration * 100));
  const state = at.getTime() < start ? "not-started" : at.getTime() >= reset ? "reset-due" : "active";
  const paceDifferencePoints = state === "active" ? window.usedPercent - elapsedPercent : null;
  return { startsAt: new Date(start).toISOString(), elapsedPercent, state, paceDifferencePoints, paceDifferenceSeconds: paceDifferencePoints === null ? null : paceDifferencePoints / 100 * window.durationSeconds };
}

export interface PacedUsageWindow {
  reported: SubscriptionUsage["windows"][number];
  timing: UsageWindowTiming;
}

/** Forecast at the average consumption rate since this window began.
 * Infinity means no projected allowance exhaustion before the next reset (or no usable rate).
 * Does not project consumption through resets. */
export function estimatedTimeToHitLimitSeconds({ reported, timing }: PacedUsageWindow): number {
  if (timing.state !== "active" || reported.durationSeconds === null) return Infinity;
  if (reported.usedPercent >= 100) return 0;
  if (reported.usedPercent === 0 || timing.elapsedPercent === 0) return Infinity;
  // Usage at or below elapsed time reaches 100% at or after the reset.
  if (reported.usedPercent <= timing.elapsedPercent) return Infinity;
  const elapsedSeconds = timing.elapsedPercent / 100 * reported.durationSeconds;
  return (100 - reported.usedPercent) / reported.usedPercent * elapsedSeconds;
}

/** Surface the active allowance with the shortest projected time to exhaustion.
 * Ties prefer higher usage. When all are unused, show the main allowance. */
export function selectPacingWindow(windows: readonly PacedUsageWindow[]): PacedUsageWindow | undefined {
  const active = windows.filter((window) => window.timing.state === "active");
  const used = active.filter((window) => window.reported.usedPercent > 0);
  if (!used.length) return active.find((window) => window.reported.meteredFeature === null) ?? active[0];
  return used.reduce((selected, window) => {
    const estimatedSeconds = estimatedTimeToHitLimitSeconds(window);
    const selectedEstimatedTimeToHitLimitSeconds = estimatedTimeToHitLimitSeconds(selected);
    return estimatedSeconds < selectedEstimatedTimeToHitLimitSeconds || (estimatedSeconds === selectedEstimatedTimeToHitLimitSeconds && window.reported.usedPercent > selected.reported.usedPercent) ? window : selected;
  });
}
