import { parseModelRef } from "@agents-in-the-cloud/llm/server";
import { renderLazyTranscriptEntry } from "@agents-in-the-cloud/agent/server/render-transcript";
import { ids, type AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import type { TranscriptItem } from "@agents-in-the-cloud/agent/server/transcript";
import { renderBackgroundActivities, type BackgroundActivity } from "@agents-in-the-cloud/agent/server/background-activity";
import { renderAgentPane, renderAgentPaneComposerFooter, renderPromptActions, type AgentStatsView } from "@agents-in-the-cloud/builtin-agent/server/render-composer";
import { LiveTranscriptRenderer, StreamingTexts } from "@agents-in-the-cloud/builtin-agent/server/render-live-transcript";
import { escapeHtml, type LiveRegion } from "@agents-in-the-cloud/shared";
import type { NativeAgentRuntime } from "./agents.ts";

export function createNativeAgentRendering<Runtime extends NativeAgentRuntime>(options: {
  channelName: string;
  routeSegment: string;
  transcript(runtime: Runtime): TranscriptItem[];
  stats(runtime: Runtime): AgentStatsView;
  background?: {
    activities(runtime: Runtime): BackgroundActivity[];
    detail(runtime: Runtime, activity: BackgroundActivity, ctx: AgentRenderContext): Promise<string>;
    route?(runtime: Runtime, activity: BackgroundActivity, path: string, url: URL, ctx: AgentRenderContext): Promise<Response | undefined>;
    stop?(runtime: Runtime, activity: BackgroundActivity): Promise<void>;
  };
}) {
  function renderContext(runtime: Runtime): AgentRenderContext {
    return { workspaceId: runtime.workspaceId, agentId: runtime.agentId, inlineWorkingItems: true, lazyCompletedWorkingItems: true, model: runtime.record.model ? parseModelRef(runtime.record.model) : undefined, transcriptBasePath: `/workspaces/${encodeURIComponent(runtime.workspaceId)}/${options.routeSegment}/${encodeURIComponent(runtime.agentId)}` };
  }
  function transcriptItems(runtime: Runtime): TranscriptItem[] {
    return [
      ...options.transcript(runtime),
      ...runtime.state.notices.map((text, index) => ({ type: "note" as const, key: `notice:${index}`, text, tone: "warning" as const })),
      ...runtime.failure ? [{ type: "error" as const, key: "connection-error", text: runtime.failure.message }] : [],
    ];
  }
  // Each row is its own region, so a change resends that row rather than the whole transcript.
  // Live messages stream their Markdown a block at a time, as the built-in Agent's do.
  const transcriptRenderers = new WeakMap<Runtime, { rows: LiveTranscriptRenderer; texts: StreamingTexts }>();
  function transcriptRegion(runtime: Runtime): LiveRegion {
    let renderer = transcriptRenderers.get(runtime);
    if (!renderer) transcriptRenderers.set(runtime, renderer = { rows: new LiveTranscriptRenderer(), texts: new StreamingTexts(runtime.workspaceId) });
    const items = transcriptItems(runtime);
    renderer.texts.retainLive(items);
    const ctx: AgentRenderContext = { ...renderContext(runtime), streamingText: renderer.texts.render };
    return renderer.rows.renderRows(ctx, items, renderLazyTranscriptEntry(ctx, "system-prompt", "System prompt"));
  }
  function liveRegions(runtime: Runtime): LiveRegion[] {
    const ctx = renderContext(runtime);
    return [
      transcriptRegion(runtime),
      { target: ids.background(ctx), html: renderBackgroundActivities(ctx, options.background?.activities(runtime) ?? []) },
      { target: ids.actions(ctx), html: renderPromptActions(ctx, runtime.isTurnRunning, runtime.isBusy) },
      { target: ids.stats(ctx), html: renderAgentPaneComposerFooter(ctx, options.stats(runtime)), morph: false },
      { target: ids.completionCatalog(ctx), html: runtime.completionCatalog },
      { target: ids.promptSuggestion(ctx), html: escapeHtml(runtime.promptSuggestion ?? "") },
    ];
  }
  async function paneHtml(runtime: Runtime) {
    await runtime.refreshCompletionCatalog();
    return renderAgentPane(renderContext(runtime), { agentId: runtime.agentId }, { regions: () => liveRegions(runtime) }, { moduleChannel: options.channelName, notifications: false, background: false, initialPromptDraft: false });
  }
  return { channelName: options.channelName, routeSegment: options.routeSegment, background: options.background, renderContext, transcriptItems, liveRegions, paneHtml };
}
export type NativeAgentRendering<Runtime extends NativeAgentRuntime> = ReturnType<typeof createNativeAgentRendering<Runtime>>;
