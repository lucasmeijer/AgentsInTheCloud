import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { defineExtension, GenerationTask, hook, type ContextView } from "@earendil-works/pi-durable";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { recordSubscriptionInference } from "@agents-in-the-cloud/llm/server";

/** Same head-cutoff rule as native automatic compaction, over derived context. */
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

/** Pacing activity, not billing: no secondary transcript or exactly-once claim. */
export function durableSubscriptionActivity(models: Pick<ModelRuntime, "getAuth">, record = recordSubscriptionInference) {
  return defineExtension({ name: "agents-in-the-cloud.subscription-activity", hooks: [hook(GenerationTask, {
    async afterResponse(message) {
      // These providers expose subscription quotas with known pacing periods.
      if ((message.provider !== "openai-codex" && message.provider !== "github-copilot") || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") return;
      if ((await models.getAuth(message.provider))?.source === "OAuth") record(message.provider);
    },
  })] });
}
