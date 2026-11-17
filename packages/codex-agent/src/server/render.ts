import { parseModelRef } from "@agents-in-the-cloud/llm/server";
import { createNativeAgentRendering } from "@agents-in-the-cloud/native-agent/server";
import { projectCodexTurns } from "./transcript.ts";
import type { CodexRuntime } from "./runtime.ts";
import { codexBackgroundActivities, codexBackgroundDetail, codexBackgroundRoute, codexSubagentAnswer } from "./background.ts";

export const rendering = createNativeAgentRendering<CodexRuntime>({
  channelName: "codex-agent",
  routeSegment: "codex-agents",
  transcript: runtime => projectCodexTurns(runtime.state.turns, runtime.state.completedItems, { answer: activity => codexSubagentAnswer(runtime, activity) }, runtime.state.itemStarts),
  background: { activities: codexBackgroundActivities, detail: codexBackgroundDetail, route: codexBackgroundRoute },
  stats(runtime) {
    const usage = runtime.state.usage;
    const selection = runtime.selection;
    return { contextPercent: usage?.modelContextWindow ? usage.last.totalTokens / usage.modelContextWindow * 100 : null, compactAvailable: !runtime.isBusy, inputTokens: usage?.total.inputTokens ?? null, outputTokens: usage?.total.outputTokens ?? null, cost: null, modelName: runtime.record.model ? parseModelRef(runtime.record.model)?.id : undefined, thinkingLevel: runtime.record.thinkingLevel ?? "", thinkingLevels: selection.thinkingLevels, models: selection.models, connectedProvider: true };
  },
});
export const liveRegions = (runtime: CodexRuntime) => rendering.liveRegions(runtime);
