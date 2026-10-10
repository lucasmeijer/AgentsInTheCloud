import { selectPacingWindow, type PacedUsageWindow } from "./usage-window.ts";
import type { UsageProvider } from "./provider-usage.ts";

const activityWindowMs = 30 * 60_000;
const lastUsed = new Map<UsageProvider["id"], number>();

/** Only successful inference with AgentsInTheCloud's connected subscription is recorded. */
export function recordSubscriptionInference(provider: UsageProvider["id"], at = Date.now()): void {
  lastUsed.set(provider, at);
}

export function forgetSubscriptionInference(provider: UsageProvider["id"]): void {
  lastUsed.delete(provider);
}

export function providersInLastInferenceWindow(): UsageProvider["id"][] {
  if (!lastUsed.size) return [];
  const latest = Math.max(...lastUsed.values());
  return [...lastUsed].filter(([, usedAt]) => latest - usedAt < activityWindowMs).map(([provider]) => provider);
}

/** Select the shortest projected time to allowance exhaustion across candidate subscriptions. */
export function selectSubscriptionLimit(
  candidates: readonly { provider: UsageProvider; windows: readonly PacedUsageWindow[] }[],
): { provider: UsageProvider; window: PacedUsageWindow } | undefined {
  const choices = candidates.flatMap(({ provider, windows }) => windows.map((window) => ({ provider, window })));
  const selected = selectPacingWindow(choices.map(({ window }) => window));
  return choices.find(({ window }) => window === selected);
}
