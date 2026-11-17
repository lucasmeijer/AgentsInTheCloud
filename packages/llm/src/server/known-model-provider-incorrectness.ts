import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Temporary Pi 0.99.1 correction: OpenAI advertises API-key-only models to
// ChatGPT subscriptions too. Remove this correction when Pi filters by credential.
// Each exact ID below was rejected as unsupported by OpenAI ChatGPT OAuth in
// live checks on 2026-09-29. Unknown/new models remain available by default.
// This list does not change API-key access or route requests through Codex.
const openaiSubscriptionDisallowedModelIds = new Set([
  "gpt-4", "gpt-4-turbo", "gpt-4.1",
  "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o",
  "gpt-4o-2024-05-13", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20",
  "gpt-4o-mini", "gpt-5", "gpt-5-chat-latest",
  "gpt-5-mini", "gpt-5-nano", "gpt-5-pro",
  "gpt-5.1", "gpt-5.2", "gpt-5.2-chat-latest",
  "gpt-5.2-pro", "gpt-5.3-chat-latest", "gpt-5.3-codex",
  "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini",
  "gpt-5.4-nano", "gpt-5.4-pro", "gpt-5.5-pro",
  "gpt-daybreak-blue-latest", "gpt-daybreak-red-latest", "gpt-realtime-2.1",
  "o1", "o1-pro", "o3",
  "o3-mini", "o3-pro", "o4-mini",
]);

export async function availableProviderModels(runtime: Pick<ModelRuntime, "getAvailable" | "checkAuth">, provider?: string) {
  const models = await runtime.getAvailable(provider);
  if (!models.some((model) => model.provider === "openai")) return models;
  const auth = await runtime.checkAuth("openai");
  if (auth?.type !== "oauth") return models;
  return models.filter((model) => model.provider !== "openai" || !openaiSubscriptionDisallowedModelIds.has(model.id));
}

export async function cheapestAvailableProviderModel(runtime: Pick<ModelRuntime, "getAvailable" | "checkAuth">, provider: string) {
  return (await availableProviderModels(runtime, provider)).toSorted((a, b) => a.cost.input - b.cost.input)[0];
}
