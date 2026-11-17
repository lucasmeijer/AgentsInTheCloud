import type { JsonRepresentation } from "@earendil-works/chord";
import type { Message, Usage, UserMessage } from "@earendil-works/pi-ai";
import { getProviderUsageOverview, supportedUsageProviders, type ProviderUsageOverview } from "@agents-in-the-cloud/llm/server";

/** Only providers on which we measured the suggestion request reading the turn's prompt cache.
 * Anthropic reads the turn's cache at the breakpoint pi-ai sets on the last message, and writes only the final reply and instruction.
 * xAI caches on a best-effort basis and occasionally misses; see `promptSuggestionCacheMissLimit`. */
export const promptSuggestionProviders: ReadonlySet<string> = new Set(["openai-codex", "xai", "anthropic"]);

export const promptSuggestionCacheMissLimit = 2;

// The first and last lines keep reasoning models brief: they must think at the turn's level to read its cache.
// On Grok they cut reasoning on an obvious next step from ~500-650 tokens to ~20-40, with the same guesses.
const instruction = `This is a quick reflex guess, not a task: answer instantly, without deliberating.
[Suggested prompt] Pause the task for a moment. Guess what the user will most likely type as their next message to you.
Base the guess on what they asked for and how they write, not on what you think they should do. A good guess makes them think "I was about to type that".
- If you just offered options, pick the one they would most likely choose.
- If you asked whether to continue, guess a short yes, like "go ahead".
- If the work is done and the follow-up is obvious, name it, like "run the tests" or "commit this".
Never guess praise or thanks, a question, something in your own voice ("I'll…", "Let me…"), a new idea they haven't raised, or more than one sentence.
Reply with nothing if the next step isn't obvious, after an error or a misunderstanding, or when the topic is sensitive.
Otherwise reply with only the guess: 2 to 12 words, in their style, without quotes. Don't use any tools.
Use at most one short sentence of thinking.`;

export function promptSuggestionRequest(timestamp: number): UserMessage {
  return { role: "user", content: instruction, timestamp };
}

const uncachedTokenLimit = 10_000;

export function promptSuggestionEligible(messages: readonly Message[]): boolean {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "stop") return false;
  if (messages.filter(message => message.role === "user").length < 2) return false;
  return last.usage.input + last.usage.output <= uncachedTokenLimit;
}

export function promptSuggestionMissedCache(usage: Pick<Usage, "input" | "cacheRead">): boolean {
  return usage.cacheRead < (usage.input + usage.cacheRead) / 2;
}

export function promptSuggestionDue(ignoredInARow: number, turnsSinceBackoff: number): boolean {
  return ignoredInARow < 3 || turnsSinceBackoff % 3 === 0;
}

const shortReplies = new Set(["yes", "yeah", "yep", "sure", "ok", "okay", "continue", "commit", "push", "deploy", "stop", "no"]);

export function acceptablePromptSuggestion(reply: string): string | undefined {
  const text = reply.trim().replace(/^(["'“])(.*)(["'”])$/s, "$2").trim();
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  const rejected = [
    !text,
    text.length >= 100,
    words > 12,
    words < 2 && !text.startsWith("/") && !shortReplies.has(lower.replace(/[.!]$/, "")),
    /[\n*`#]/.test(text),
    /[.!?]\s+\S/.test(text),
    text.endsWith("?"),
    /^\w+:\s/.test(text),
    /^[([].*[)\]]$/.test(text),
    /^(done|nothing\b|no suggestion|none\b)|\bsilen(t|ce)\b/.test(lower),
    /\b(thanks|thank you|looks good|sounds good|that works|great|perfect|nice|awesome|makes sense)\b/.test(lower),
    /^(let me|i'll|i've|i'm|i can|i would|i think|here's|here is|you can|you should|sure,|of course|certainly)/.test(lower),
  ];
  return rejected.some(Boolean) ? undefined : text;
}

export function subscriptionNearLimit(overview: Pick<ProviderUsageOverview, "reported">): boolean {
  const reported = overview.reported;
  return Boolean(reported && (reported.limitReached || reported.windows.some(window => window.usedPercent >= 90)));
}

export async function providerNearUsageLimit(provider: string): Promise<boolean> {
  const usageProvider = supportedUsageProviders.find(candidate => candidate.id === provider);
  return usageProvider ? subscriptionNearLimit(await getProviderUsageOverview(usageProvider)) : false;
}

export function addModelUsage(models: Record<string, JsonRepresentation<Usage>>, key: string, usage: Usage): void {
  const total = Object.hasOwn(models, key) ? models[key] : undefined;
  if (!total) {
    const { cacheWrite1h, reasoning, cost, ...counts } = usage;
    const copy: JsonRepresentation<Usage> = { ...counts, cost: { ...cost } };
    if (cacheWrite1h !== undefined) copy.cacheWrite1h = cacheWrite1h;
    if (reasoning !== undefined) copy.reasoning = reasoning;
    models[key] = copy;
    return;
  }
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}
