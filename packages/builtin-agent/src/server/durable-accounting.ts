import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, type ContextView } from "@earendil-works/pi-durable";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { hasUsageLimits, recordSubscriptionInference, supportedUsageProviders } from "@agents-in-the-cloud/llm/server";

export function durableContextTokens(view: ContextView): number {
  const cutoff = view.head?.id ?? Number.NEGATIVE_INFINITY;
  let measured;
  for (let index = view.entries.length - 1; index >= 0 && !measured; index--) {
    if (view.entries[index].id <= cutoff) continue;
    measured = view.contributions[index].findLast(message => message.role === "assistant" && calculateContextTokens(message.usage) > 0);
  }
  const from = measured ? view.messages.lastIndexOf(measured) + 1 : 0;
  return (measured?.role === "assistant" ? calculateContextTokens(measured.usage) : 0)
    + view.messages.slice(from).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export async function recordDurableSubscriptionActivity(models: Pick<ModelRuntime, "getAuth">, message: AssistantMessage, record = recordSubscriptionInference): Promise<void> {
  if (!["openai-codex", "github-copilot", "opencode-go"].includes(message.provider) || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") return;
  const provider = supportedUsageProviders.find((supported) => supported.id === message.provider)!;
  if (hasUsageLimits(provider, await models.getAuth(provider.id))) record(provider.id);
}

export function durableSubscriptionActivity(models: Pick<ModelRuntime, "getAuth">, record = recordSubscriptionInference) {
  return defineExtension({ name: "agents-in-the-cloud.subscription-activity", hooks: [hook(GenerationTask, {
    afterResponse: (message) => recordDurableSubscriptionActivity(models, message, record),
  })] });
}
