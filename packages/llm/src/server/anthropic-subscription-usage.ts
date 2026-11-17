import { Type } from "typebox";
import { Value } from "typebox/value";
import { readSubscriptionUsageJson, requestSubscriptionUsage, SubscriptionUsageError, type Fetcher, type SubscriptionUsage } from "./subscription-usage.ts";
import { recordSubscriptionInference } from "./recent-subscription-activity.ts";
type UsageWindow = SubscriptionUsage["windows"][number];

const accountWindowSchema = Type.Object({
  utilization: Type.Number({ minimum: 0, maximum: 100 }),
  resets_at: Type.Union([Type.String(), Type.Null()]),
});
const scopedLimitSchema = Type.Object({
  percent: Type.Number({ minimum: 0 }),
  resets_at: Type.Union([Type.String(), Type.Null()]),
});
const scopedModelSchema = Type.Object({ model: Type.Object({ display_name: Type.String({ minLength: 1 }) }) });
const limitsSchema = Type.Array(Type.Record(Type.String(), Type.Unknown()));
const scopedLimitFeature = "weekly_scoped";
const unrecognizedHeaders = () => new SubscriptionUsageError("Anthropic returned unrecognized rate limit headers.");
const unrecognizedAccountUsageMessage = "Anthropic returned an unrecognized usage response.";
const unrecognizedAccountUsage = () => new SubscriptionUsageError(unrecognizedAccountUsageMessage);
const unitSeconds = new Map([["h", 3600], ["hour", 3600], ["d", 86400], ["day", 86400]]);
const fableFeatures = new Set(["oi", "overage_included"]);
const featureNames = new Map([...[...fableFeatures].map((feature) => [feature, "Fable"] as const), ["opus", "Opus"], ["sonnet", "Sonnet"]]);
const numberWords = new Map(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map((word, index) => [word, index + 1]));

/** Anthropic names each window by its length and, for a metered feature, a suffix:
 * "5h" or "7d_opus" in headers, "five_hour" or "seven_day_opus" from the account
 * endpoint. The shortest reported window is the primary one. Windows whose names
 * don't state a length can't be paced, so they are left out. */
type ReportedWindow = { count: number; unit: string; feature: string | undefined; name?: string; usedPercent: number; resetsAt: string | null; limitReached?: true };
function namedWindows(reported: ReportedWindow[]): UsageWindow[] {
  const windows = reported.map(({ count, unit, feature, name, usedPercent, resetsAt, limitReached }) => ({
    limitName: name ?? (feature ? featureNames.get(feature) ?? feature.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase()) : "Claude"),
    meteredFeature: feature ?? null,
    usedPercent,
    durationSeconds: count * unitSeconds.get(unit)!,
    resetsAt,
    ...(limitReached && { limitReached }),
  }));
  const shortest = Math.min(...windows.map((window) => window.durationSeconds));
  return windows.map((window) => ({ ...window, kind: window.durationSeconds === shortest ? "primary" : "secondary" }));
}

async function requestAnthropic(url: string, accessToken: string, init: { method?: string; headers?: Record<string, string>; body?: string }, fetcher: Fetcher): Promise<Response> {
  const headers = { ...init.headers, Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" };
  return await requestSubscriptionUsage(url, { ...init, headers }, "Could not reach Anthropic to check subscription usage. Try again.", fetcher);
}

function anthropicHttpError(response: Response): SubscriptionUsageError {
  if (response.status === 401) return new SubscriptionUsageError("Anthropic rejected the credentials. Reconnect Anthropic.");
  if (response.status === 403) return new SubscriptionUsageError("Anthropic denied subscription usage access (HTTP 403). Reconnect Anthropic with subscription OAuth sign-in.");
  const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
  return new SubscriptionUsageError(`Anthropic usage is unavailable (HTTP ${response.status}). Try again later.`, Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null);
}

/** Claude's OAuth account endpoint. Not a public, versioned API, and heavily rate limited
 * (429 with an hour-long retry-after), so it only adds windows the headers lack.
 * Entries without a length in their name, such as monetary extra_usage, aren't windows.
 * Model-scoped weekly caps, such as Fable's, only appear in its limits[], named by model. */
export async function fetchAnthropicAccountUsage(accessToken: string, fetcher: Fetcher = fetch): Promise<UsageWindow[]> {
  const response = await requestAnthropic("https://api.anthropic.com/api/oauth/usage", accessToken, {}, fetcher);
  if (!response.ok) throw anthropicHttpError(response);
  const payload = await readSubscriptionUsageJson(response, Type.Record(Type.String(), Type.Unknown()), {
    invalid: "Anthropic returned an invalid usage response.",
    unrecognized: unrecognizedAccountUsageMessage,
  });
  const buckets = Object.entries(payload).flatMap(([key, window]): ReportedWindow[] => {
    const name = key.match(/^([a-z]+)_(hour|day)(?:_(.+))?$/);
    const count = name && numberWords.get(name[1]!);
    if (!count || window === null) return [];
    if (!Value.Check(accountWindowSchema, window)) throw unrecognizedAccountUsage();
    return [{ count, unit: name[2]!, feature: name[3], usedPercent: window.utilization, resetsAt: accountResetsAt(window.resets_at) }];
  });
  const limits = payload.limits ?? [];
  if (!Value.Check(limitsSchema, limits)) throw unrecognizedAccountUsage();
  const scoped = limits.flatMap((limit): ReportedWindow[] => {
    if (limit.kind !== "weekly_scoped") return [];
    const scope = limit.scope;
    if (!Value.Check(scopedLimitSchema, limit)) throw unrecognizedAccountUsage();
    if (!Value.Check(scopedModelSchema, scope)) return [];
    return [{ count: 7, unit: "d", feature: scopedLimitFeature, name: scope.model.display_name, usedPercent: limit.percent, resetsAt: accountResetsAt(limit.resets_at) }];
  });
  // A used-up feature cap is reported at 100%; the headers only say so on that model's own requests.
  // Shared windows are left to the headers' account-wide decision.
  const windows = namedWindows([...buckets, ...scoped].map((window) => window.feature !== undefined && window.usedPercent >= 100 ? { ...window, limitReached: true as const } : window));
  // One cap can be both a bucket and a limits[] entry, rounding its usage differently; it's
  // reached if either says so, and then lasts until that one's reset, when the bucket has none.
  const reached = new Map(windows.filter((window) => window.limitReached).map((window) => [windowName(window), window] as const));
  return uniqueWindows(windows).map((window) => {
    const reachedBy = reached.get(windowName(window));
    return reachedBy ? { ...window, limitReached: true, resetsAt: window.resetsAt ?? reachedBy.resetsAt } : window;
  });
}

function accountResetsAt(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const reset = new Date(resetsAt);
  if (!Number.isFinite(reset.getTime())) throw unrecognizedAccountUsage();
  return reset.toISOString();
}

/** Subscription OAuth responses from /v1/messages carry the account's unified limits.
 * Returns null when the response carries none, such as API-key traffic.
 * Anthropic rejects the account overall when only a model's own cap, such as Fable's
 * "7d_oi", ran out. Other models still work then, so only that window is limited. */
export function anthropicUsageFromHeaders(headers: Headers, checkedAt: Date): SubscriptionUsage | null {
  const status = headers.get("anthropic-ratelimit-unified-status");
  if (status === null) return null;
  const reported = [...headers].flatMap(([header, utilization]) => {
    const name = header.match(/^anthropic-ratelimit-unified-(\d+)([hd])(?:[-_](.+))?-utilization$/);
    if (!name) return [];
    const used = Number(utilization);
    if (utilization.trim() === "" || !Number.isFinite(used) || used < 0) throw unrecognizedHeaders();
    const resetHeader = headers.get(header.replace(/-utilization$/, "-reset"));
    const reset = resetHeader === null ? null : Number(resetHeader);
    if (reset !== null && (resetHeader!.trim() === "" || !Number.isInteger(reset) || reset <= 0)) throw unrecognizedHeaders();
    const windowStatus = headers.get(header.replace(/-utilization$/, "-status"));
    return [{ count: Number(name[1]), unit: name[2]!, feature: name[3], usedPercent: used * 100, resetsAt: reset === null ? null : new Date(reset * 1000).toISOString(), status: windowStatus }];
  });
  const reached = (window: (typeof reported)[number]) => window.status === "rejected" || (window.status === null && window.usedPercent >= 100);
  const windows = namedWindows(reported.map((window) => reached(window) ? { ...window, limitReached: true as const } : window));
  const shared = reported.filter((window) => window.feature === undefined && (window.status !== null || reached(window)));
  const sharedAllowed = shared.length > 0 && shared.every((window) => window.status === "allowed" || window.status === "allowed_warning");
  const onlyScopedRejected = sharedAllowed && reported.some((window) => window.feature !== undefined && reached(window));
  const limitReached = status === "rejected" && !onlyScopedRejected;
  return { plan: null, checkedAt: checkedAt.toISOString(), allowed: !limitReached, limitReached, windows, details: extraUsage(headers) };
}

/** Extra usage is billed per token once plan limits run out. Anthropic says whether it's
 * available ("allowed", "allowed_warning" or "rejected") and, when it isn't, why, such as "out_of_credits". */
function extraUsage(headers: Headers): SubscriptionUsage["details"] {
  const status = headers.get("anthropic-ratelimit-unified-overage-status");
  if (status === null) return undefined;
  const reason = headers.get("anthropic-ratelimit-unified-overage-disabled-reason");
  const value = status === "allowed" ? "On" : status === "allowed_warning" ? "On, nearly used up" : status === "rejected" ? (reason ? `Off, ${reason}` : "Off") : status;
  return [{ label: "Extra usage", value: value.replaceAll("_", " ") }];
}

export async function probeAnthropicSubscriptionUsage(accessToken: string, model: string, fetcher: Fetcher = fetch): Promise<SubscriptionUsage> {
  const response = await requestAnthropic("https://api.anthropic.com/v1/messages", accessToken, {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "." }],
    }),
  }, fetcher);
  await response.body?.cancel();
  const usage = anthropicUsageFromHeaders(response.headers, new Date());
  if (!usage) throw anthropicHttpError(response);
  return usage;
}

function singleFlight<Args extends unknown[], Result>(start: (...args: Args) => Promise<Result>) {
  let pending: Promise<Result> | undefined;
  return {
    run(...args: Args): Promise<Result> {
      if (pending) return pending;
      const started = start(...args).finally(() => { if (pending === started) pending = undefined; });
      pending = started;
      return started;
    },
    clear(): void { pending = undefined; },
  };
}

/** The headers and the account endpoint name a feature's window differently ("7d_oi" and a
 * weekly_scoped "Fable"), so they're matched by the name they're shown with. */
const windowName = (window: UsageWindow) => `${window.durationSeconds} ${window.meteredFeature === null ? "" : window.limitName}`;

/** The headers never name the model a cap applies to; the account endpoint does. Its
 * model-scoped caps named like another feature's window, such as Sonnet's, are that window.
 * When a single other one remains, it's the one behind "7d_oi", so that window takes its name. */
function withScopedNames(windows: UsageWindow[], accountWindows: UsageWindow[]): UsageWindow[] {
  const otherFeatures = new Set([...featureNames].filter(([feature]) => !fableFeatures.has(feature)).map(([, name]) => name));
  for (const window of [...windows, ...accountWindows]) {
    if (window.meteredFeature !== null && window.meteredFeature !== scopedLimitFeature && !fableFeatures.has(window.meteredFeature)) otherFeatures.add(window.limitName);
  }
  const scoped = accountWindows.filter((window) => window.meteredFeature === scopedLimitFeature && !otherFeatures.has(window.limitName));
  if (scoped.length !== 1) return windows;
  return windows.map((window) => window.meteredFeature !== null && fableFeatures.has(window.meteredFeature) ? { ...window, limitName: scoped[0]!.limitName } : window);
}

function uniqueWindows(windows: UsageWindow[]): UsageWindow[] {
  const seen = new Set<string>();
  return windows.filter((window) => {
    const name = windowName(window);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** Usage for this host's connected subscription. Usage only rises with use, and
 * Claude Code traffic through the workspace proxy keeps the snapshot current. Anthropic
 * is asked only on the first read after start or a credential change, when a window
 * has reset, and on an explicit refresh, so an idle AgentsInTheCloud stays quiet. */
export function createAnthropicUsageSource(fetcher: Fetcher = fetch, now: () => number = Date.now) {
  let observed: SubscriptionUsage | undefined;
  let accountWindows: UsageWindow[] = [];
  let accountUsageAllowedAt = 0;
  let generation = 0;

  function record(usage: SubscriptionUsage): void {
    if (observed && observed.checkedAt > usage.checkedAt) return;
    observed = usage;
  }

  const probe = singleFlight(async (token: string, model: string) => {
    const started = generation;
    const result = await probeAnthropicSubscriptionUsage(token, model, fetcher);
    const usage = { ...result, checkedAt: new Date(now()).toISOString() };
    if (generation === started) record(usage);
    return usage;
  });

  const accountUsage = singleFlight(async (token: string) => {
    if (now() < accountUsageAllowedAt) return;
    const started = generation;
    try {
      const windows = await fetchAnthropicAccountUsage(token, fetcher);
      if (generation === started) accountWindows = windows;
    } catch (error) {
      if (!(error instanceof SubscriptionUsageError)) throw error;
      if (generation === started) accountUsageAllowedAt = now() + (error.retryAfterSeconds ?? 0) * 1000;
    }
  });

  return {
    observe(headers: Headers): void {
      const usage = anthropicUsageFromHeaders(headers, new Date(now()));
      if (usage) record(usage);
    },
    forget(): void {
      generation++;
      observed = undefined;
      probe.clear();
      accountUsage.clear();
      accountWindows = [];
      accountUsageAllowedAt = 0;
    },
    async usage(token: string, options: { model: string; refresh: boolean }): Promise<SubscriptionUsage> {
      let usage = observed;
      const resetPassed = usage?.windows.some((window) => window.resetsAt !== null && new Date(window.resetsAt).getTime() <= now());
      if (options.refresh || !usage || resetPassed) [usage] = await Promise.all([probe.run(token, options.model), accountUsage.run(token)]);
      // Headers are current; the account endpoint only adds windows they lack. Its windows are
      // kept while it's rate limited, but not past their reset, when what they say is out of date.
      const current = accountWindows.filter((window) => window.resetsAt === null || new Date(window.resetsAt).getTime() > now());
      return { ...usage, windows: uniqueWindows([...withScopedNames(usage.windows, current), ...current]) };
    },
  };
}

export const anthropicUsageSource = createAnthropicUsageSource();

export function observeAnthropicSubscriptionResponse(headers: Headers, succeededInference: boolean): void {
  try {
    if (headers.has("anthropic-ratelimit-unified-status")) anthropicUsageSource.observe(headers);
    if (succeededInference) recordSubscriptionInference("anthropic");
  } catch (error) {
    if (!(error instanceof SubscriptionUsageError)) throw error;
    console.warn(`[usage] ${error.message}`);
  }
}
