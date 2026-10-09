import { disclosureHtml } from "@agents-in-the-cloud/design-system/disclosure";
import { response } from "@agents-in-the-cloud/shared/http";
import { requestAcceptsJson } from "@agents-in-the-cloud/core";
import { providerUsageFrameId, providersInLastInferenceWindow, selectSubscriptionLimit, estimatedTimeToHitLimitSeconds, type PacedUsageWindow, connectedUsageProviders, getProviderUsageOverview, supportedUsageProviders, type ProviderUsageOverview } from "@agents-in-the-cloud/llm/server";
import { actionLinkHtml } from "@agents-in-the-cloud/design-system/action-link";
import { comparisonRingHtml } from "@agents-in-the-cloud/design-system/comparison-ring";
import { helpTipHtml } from "@agents-in-the-cloud/design-system/help-tip";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml, turboStream, turboStreamResponse } from "@agents-in-the-cloud/shared";

function jsonResponse<Body extends object>(body: Body, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function renderUsagePaneAction(): string {
  const button = usageButtonHtml();
  const actions = [
    "agents-in-the-cloud:usage:refreshed@document->usage-button#refresh",
    "visibilitychange@document->usage-button#refresh",
    "focus@window->usage-button#refresh",
  ].join(" ");
  return `<span data-controller="usage-button" data-action="${actions}"><template data-usage-button-target="empty">${button}</template><turbo-frame id="usage_button_content">${button}</turbo-frame></span>`;
}
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** Two compact units for allowance windows, reset countdowns, and pacing gaps. */
function usageDuration(seconds: number | null): string {
  if (seconds === null) return "Unknown period";
  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];
  for (const [size, suffix] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]] as const) {
    const count = Math.floor(remaining / size);
    remaining %= size;
    if (count) parts.push(`${count}${suffix}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0s";
}

/** Display the schedule distance, not a prediction of allowance exhaustion. */
function usagePace(seconds: number | null): string {
  if (seconds === null) return "";
  if (Math.abs(seconds) < 1) return "On pace";
  return `${usageDuration(Math.abs(seconds))} ${seconds > 0 ? "ahead of" : "behind"} pace`;
}

function renderUsageWindow(paced: PacedUsageWindow): string {
  const { reported: window, timing } = paced;
  const label = window.durationSeconds === null ? window.limitName : `${window.limitName} · ${usageDuration(window.durationSeconds)}`;
  const remaining = window.resetsAt === null ? null : (new Date(window.resetsAt).getTime() - Date.now()) / 1000;
  const reset = remaining === null ? "Reset time unavailable" : remaining > 0 ? `Resets in ${usageDuration(remaining)}` : "Reset due";
  const difference = timing.paceDifferenceSeconds;
  const pace = difference === null ? "—" : Math.abs(difference) < 1 ? "on pace" : `${usageDuration(Math.abs(difference))} ${difference > 0 ? "ahead" : "behind"}`;
  const estimatedTimeToHitLimitSecondsValue = estimatedTimeToHitLimitSeconds(paced);
  const estimatedTimeToHitLimit = timing.state !== "active" || (timing.elapsedPercent === 0 && window.usedPercent > 0 && window.usedPercent < 100)
    ? "—" : estimatedTimeToHitLimitSecondsValue === Infinity ? "Not before reset" : usageDuration(estimatedTimeToHitLimitSecondsValue);
  const elapsed = timing.elapsedPercent;
  return `<article class="usage-limit">
    <div class="usage-limit-title"><h3>${escapeHtml(label)}</h3>
      ${elapsed === null ? "" : `<div class="usage-comparison${difference === null ? " usage-comparison--inactive" : ""}" aria-hidden="true">
        <span class="usage-comparison__time" style="width:${elapsed}%"></span>
        <span class="usage-comparison__usage" style="width:${window.usedPercent}%"></span>
        <span class="usage-comparison__shared" style="width:${Math.min(elapsed, window.usedPercent)}%"></span>
      </div>`}
    </div>
    <div class="usage-metrics usage-caption" tabindex="0" role="group" aria-label="Limit metrics">
      <div class="usage-metrics-row">
      <span>Time ${elapsed === null ? "—" : `${number(elapsed)}%`} ${helpTipHtml({ label: "What is time?", text: "How much of this limit's time window has passed. It starts over when the limit resets." })}</span>
      <span>Used ${number(window.usedPercent)}%</span>
      <span>${reset}</span>
      </div>
      <div class="usage-metrics-row">
      <span>Estimated time to hit limit: ${estimatedTimeToHitLimit} ${helpTipHtml({ label: "What is estimated time to hit limit?", text: "An estimate based on your average usage rate so far. It does not project beyond the next reset." })}</span>
      <span>Pace ${pace} ${helpTipHtml({ label: "What is pace?", text: "How your usage compares to spreading it evenly over the window. Ahead means you're using it faster than that, behind means you have room to spare." })}</span>
      </div>
    </div>
  </article>`;
}

function shownUsageWindows(windows: PacedUsageWindow[]) {
  return {
    used: windows.filter(({ reported }) => reported.usedPercent > 0),
    unused: windows.filter(({ reported }) => reported.usedPercent === 0 && reported.meteredFeature !== "chatpass"),
  };
}

/** A failed usage check says nothing about whether the provider's models work, so it reads as a note, not an alert. */
function renderUsageLimits({ reported, error, windows }: ProviderUsageOverview): string {
  if (error) return `<div class="usage-unavailable" role="status"><p>Couldn’t check usage limits. This only affects the usage shown here; models may still work fine.</p><p class="usage-caption">${escapeHtml(error)}</p></div>`;
  if (!reported) return "<p>Disconnected.</p>";
  const { used, unused } = shownUsageWindows(windows);
  return `${reported.limitReached || reported.allowed === false ? '<p class="usage-error" role="status">Subscription limit reached.</p>' : ""}${used.map(renderUsageWindow).join("")}${unused.length ? disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: `Unused limits (${unused.length})` } }, open: !used.length, bodyHtml: `<div class="usage-section">${unused.map(renderUsageWindow).join("")}</div>` }) : ""}${used.length || unused.length || reported.balance ? "" : '<p>No limits reported.</p>'}`;
}

function money(amount: number, currency: string): string {
  return amount.toLocaleString("en-US", { style: "currency", currency });
}

function renderUsageAccount({ reported, error }: ProviderUsageOverview): string {
  if (!reported || error) return "";
  const { credits, resets, balance } = reported;
  const rows: string[] = [];
  if (balance) rows.push(`<div class="usage-limit-heading"><dt>Available credit</dt><dd><strong>${money(balance.available, balance.currency)}</strong></dd></div>`, `<div class="usage-limit-heading"><dt>Spent this month</dt><dd><strong>${money(balance.monthSpend, balance.currency)}</strong></dd></div>`);
  if (resets) rows.push(`<div class="usage-limit-heading"><dt>Available resets</dt><dd><strong>${number(resets.available)}</strong></dd></div>`);
  if (credits) rows.push(`<div class="usage-limit-heading"><dt>Credit balance</dt><dd><strong>${credits.unlimited ? "Unlimited" : credits.balance !== null ? Number(credits.balance).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "Not reported"}</strong></dd></div>`);
  if (!rows.length) return "";
  return `<article class="usage-limit"><h3>${balance ? "Credits" : "Account allowance"}</h3><dl class="usage-account">${rows.join("")}</dl></article>`;
}

function usageWindowCaption(window: PacedUsageWindow["reported"]): string {
  return window.meteredFeature === null ? usageDuration(window.durationSeconds).split(" ")[0]! : window.limitName.slice(0, 2);
}

/** Prepaid providers show their balance instead. One small ring per limit: its length for main allowances ("5h"), the first letters of a feature's name ("Op") otherwise. */
function renderUsageRings({ provider, reported, error, windows }: ProviderUsageOverview, scope: string): string {
  const { used, unused } = shownUsageWindows(windows);
  const rings = reported && !error ? [...used, ...unused].map(({ reported: window, timing }) => comparisonRingHtml({
    caption: usageWindowCaption(window),
    referencePercent: timing.elapsedPercent ?? 0,
    valuePercent: window.usedPercent,
    label: `${window.limitName} · ${usageDuration(window.durationSeconds)}: ${timing.elapsedPercent === null ? "Pacing unavailable" : `Time ${number(timing.elapsedPercent)}%`}, Usage ${number(window.usedPercent)}%`,
  })).join("") : "";
  const balance = reported?.balance && !error ? `<span class="usage-caption">${money(reported.balance.available, reported.balance.currency)} left</span>` : "";
  return `<turbo-frame class="usage-rings" id="${providerUsageFrameId("rings", provider.id, scope)}">${rings || balance || `<span class="usage-caption"${error ? ` title="${escapeHtml(error)}"` : ""}>Usage unavailable</span>`}</turbo-frame>`;
}

/** Refresh the card's rings from the same snapshot as its expanded limits. */
function renderUsageProviderLimits(overview: ProviderUsageOverview, scope: string): string {
  return `<turbo-frame id="${providerUsageFrameId("limits", overview.provider.id, scope)}"><section class="usage-section" data-controller="usage-snapshot">${renderUsageLimits(overview)}${renderUsageAccount(overview)}</section>${turboStream("replace", providerUsageFrameId("rings", overview.provider.id, scope), renderUsageRings(overview, scope))}</turbo-frame>`;
}

/** Opens the Models dialog, with the provider whose limit the ring shows already open. */
function usageButtonHtml(comparison?: { referencePercent: number; valuePercent: number }, label = "Usage", caption?: string, provider?: string): string {
  const iconHtml = caption === undefined ? Icons.Usage : `<span class="comparison-ring__caption">${escapeHtml(caption)}</span>`;
  const href = provider ? `/models?focus=${encodeURIComponent(provider)}` : "/models";
  return actionLinkHtml({ href, variant: "secondary", content: { kind: "icon-only", iconHtml, label }, perimeterComparison: comparison, attributesHtml: 'data-turbo-stream="true"' });
}

async function renderUsageButton(): Promise<string> {
  const activity = providersInLastInferenceWindow();
  if (!activity.length) return usageButtonHtml(undefined, "Usage — no subscription inference recorded");
  const overviews = await Promise.all(supportedUsageProviders.filter((provider) => activity.includes(provider.id)).map((provider) => getProviderUsageOverview(provider)));
  const selected = selectSubscriptionLimit(overviews);
  if (!selected) return usageButtonHtml(undefined, "Usage — selected subscription limits unavailable");
  const { provider, window: { reported, timing } } = selected;
  if (timing.state !== "active") throw new Error("Selected subscription limit must be active");
  const pace = usagePace(timing.paceDifferenceSeconds);
  return usageButtonHtml({ referencePercent: timing.elapsedPercent, valuePercent: reported.usedPercent }, `Usage — ${provider.label} · ${reported.limitName} ${usageDuration(reported.durationSeconds)}: Time ${number(timing.elapsedPercent)}%, Usage ${number(reported.usedPercent)}% · ${pace} · Providers from 30 minutes before last inference`, usageWindowCaption(reported), provider.id);
}

export async function handleUsageRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (request.method !== "GET") return undefined;
  const json = requestAcceptsJson(request);
  const refresh = url.searchParams.has("refresh");
  if (url.pathname === "/usage/button") {
    const button = await renderUsageButton();
    return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html")
      ? turboStreamResponse(turboStream("update", "usage_button_content", button))
      : response(`<turbo-frame id="usage_button_content">${button}</turbo-frame>`);
  }
  if (url.pathname === "/usage" && json) return jsonResponse({ providers: await Promise.all((await connectedUsageProviders()).map((provider) => getProviderUsageOverview(provider, { refresh }))) });
  // The bare provider URL is JSON only; its limits and rings frames are what Models panel cards embed.
  const match = url.pathname.match(/^\/usage\/providers\/([^/]+)(?:\/(limits|rings))?$/);
  if (!match || (!match[2] && !json)) return undefined;
  const provider = supportedUsageProviders.find((provider) => provider.id === match[1]);
  if (!provider) return jsonResponse({ error: { code: "unsupported_usage_provider", message: "Subscription usage is not supported for this provider." } }, 404);
  const overview = await getProviderUsageOverview(provider, { refresh });
  if (!match[2]) return jsonResponse(overview);
  // Each Models panel host names its scope so its frame ids match.
  const scope = url.searchParams.get("scope") ?? "";
  return response(match[2] === "limits" ? renderUsageProviderLimits(overview, scope) : renderUsageRings(overview, scope));
}
