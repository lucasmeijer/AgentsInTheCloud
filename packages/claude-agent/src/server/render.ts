import { createNativeAgentRendering } from "@agents-in-the-cloud/native-agent/server";
import { projectClaudeTranscript } from "./transcript.ts";
import type { ClaudeRuntime } from "./runtime.ts";
import { claudeBackgroundActivities, claudeBackgroundDetail, claudeBackgroundRoute } from "./background.ts";

export const rendering = createNativeAgentRendering<ClaudeRuntime>({
  channelName: "claude-agent",
  routeSegment: "claude-code-agents",
  transcript: runtime => projectClaudeTranscript(runtime.state, runtime.isTurnRunning),
  background: { activities: claudeBackgroundActivities, detail: claudeBackgroundDetail, route: claudeBackgroundRoute, stop: (runtime, activity) => runtime.stopTask(activity.key) },
  stats(runtime) {
    const usage = [...new Map(runtime.state.rows.flatMap(row => row.kind === "assistant" && row.usage ? [[row.messageId, row.usage] as const] : [])).values()];
    const selection = runtime.selection;
    return {
      contextPercent: runtime.contextPercent, compactAvailable: !runtime.isTurnRunning,
      inputTokens: usage.length ? usage.reduce((total, value) => total + value.input_tokens + (value.cache_creation_input_tokens ?? 0) + (value.cache_read_input_tokens ?? 0), 0) : null,
      outputTokens: usage.length ? usage.reduce((total, value) => total + value.output_tokens, 0) : null,
      cost: null, modelName: runtime.selectedModel?.displayName, thinkingLevel: runtime.record.thinkingLevel ?? "", thinkingLevels: selection.thinkingLevels, models: selection.models, connectedProvider: true,
    };
  },
});
export const liveRegions = (runtime: ClaudeRuntime) => rendering.liveRegions(runtime);
