import { Type } from "typebox";
import { fetchSubscriptionUsageJson, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";

const payloadSchema = Type.Object({
  currency: Type.String({ minLength: 1 }),
  balance: Type.Object({ available: Type.Number() }),
  current_period: Type.Object({ ends_at: Type.String(), actual_charged: Type.Number({ minimum: 0 }) }),
});

export async function fetchRadiusUsage(accessToken: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  const payload = await fetchSubscriptionUsageJson("https://radius.pi.dev/v1/billing", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  }, payloadSchema, {
    unreachable: "Could not reach Radius to check credits. Try again.",
    rejected: "Radius rejected the credentials. Reconnect Radius.",
    unavailable: (status) => `Radius credits are unavailable (HTTP ${status}). Try again later.`,
    invalid: "Radius returned an invalid billing response.",
    unrecognized: "Radius returned an unrecognized billing response.",
  }, fetcher);
  return {
    plan: null,
    checkedAt: new Date().toISOString(),
    allowed: null,
    limitReached: null,
    windows: [],
    balance: { currency: payload.currency, available: payload.balance.available, monthSpend: payload.current_period.actual_charged },
  };
}
