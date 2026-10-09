import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export type SubscriptionUsage = {
  plan: string | null;
  checkedAt: string;
  allowed: boolean | null;
  limitReached: boolean | null;
  credits?: { unlimited: boolean; balance: string | null };
  resets?: { available: number };
  /** Prepaid money rather than allowance windows; amounts are in currency units. */
  balance?: { currency: string; available: number; monthSpend: number };
  windows: { limitName: string; meteredFeature: string | null; kind: "primary" | "secondary"; usedPercent: number; durationSeconds: number | null; resetsAt: string | null }[];
};

/** Expected provider/authentication failures that can be shown in the usage overview. */
export class SubscriptionUsageError extends Error {
  /** Seconds the provider asked us to wait before asking again, when it said. */
  constructor(message: string, readonly retryAfterSeconds: number | null = null) { super(message); }
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type SubscriptionUsageMessages = {
  unreachable: string;
  rejected: string;
  unavailable: (status: number) => string;
  invalid: string;
  unrecognized: string;
};

/** The usual wording for a provider whose usage endpoint reports subscription usage. */
export function subscriptionUsageMessages(provider: string, reconnect: string = provider): SubscriptionUsageMessages {
  return {
    unreachable: `Could not reach ${provider} to check subscription usage. Try again.`,
    rejected: `${provider} rejected the credentials. Reconnect ${reconnect}.`,
    unavailable: (status) => `${provider} usage is unavailable (HTTP ${status}). Try again later.`,
    invalid: `${provider} returned an invalid usage response.`,
    unrecognized: `${provider} returned an unrecognized usage response.`,
  };
}

export async function requestSubscriptionUsage(url: string, init: RequestInit, unreachable: string, fetcher: Fetcher): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
  } catch {
    throw new SubscriptionUsageError(unreachable);
  }
}

export async function readSubscriptionUsageJson<Schema extends TSchema>(response: Response, schema: Schema, messages: Pick<SubscriptionUsageMessages, "invalid" | "unrecognized">): Promise<Static<Schema>> {
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new SubscriptionUsageError(messages.invalid); }
  if (!Value.Check(schema, payload)) throw new SubscriptionUsageError(messages.unrecognized);
  return payload;
}

export async function fetchSubscriptionUsageJson<Schema extends TSchema>(url: string, init: RequestInit, schema: Schema, messages: SubscriptionUsageMessages, fetcher: Fetcher): Promise<Static<Schema>> {
  const response = await requestSubscriptionUsage(url, init, messages.unreachable, fetcher);
  if (response.status === 401) throw new SubscriptionUsageError(messages.rejected);
  if (!response.ok) throw new SubscriptionUsageError(messages.unavailable(response.status));
  return await readSubscriptionUsageJson(response, schema, messages);
}
