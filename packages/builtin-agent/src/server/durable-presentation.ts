import type { Context } from "@earendil-works/chord";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { type Conversation, type ConversationView, type WatchHandle } from "@earendil-works/pi-durable";
import { createLivePresentation, type LiveRegion, type LiveRegionDigests } from "@agents-in-the-cloud/shared";
import type { AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import { LiveTranscriptRenderer, StreamingTexts } from "./render-live-transcript.ts";
import { renderModelContextDetailFrame, renderTranscriptItemDetailFrame, type AgentModelContextView } from "@agents-in-the-cloud/agent/server/render-transcript";
import type { AgentLivePresentationListener, AgentLivePresentationSubscription } from "./runtime-types.ts";
import { findTranscriptItem, isTranscriptTarget, type TranscriptItem } from "@agents-in-the-cloud/agent/server/transcript";
import { activeConversationView, durableViewState, projectDurableTranscript } from "./durable-transcript.ts";
import { onValues } from "./durable-watch.ts";

/**
 * A window that never drops entries: the transcript shows the whole active context, not only its newest entries.
 * Durable scans one entry more than the window holds, which must stay a safe integer.
 */
const wholeWindow = Number.MAX_SAFE_INTEGER - 1;

/**
 * Server-rendered native transcript adapter. The execution owner outlives this
 * mount: disconnect/dispose only detaches observation, never cancels durable work.
 * No optimistic user rows, provider callbacks, timers or secondary transcript.
 * Runtime chrome (composer settings, notifications, catalog) stays with the host.
 */
export class DurableAgentPresentation {
  private readonly renderer = new LiveTranscriptRenderer();
  private readonly markdown: StreamingTexts;
  private readonly turns = new Map<string, { presentation: ReturnType<typeof createLivePresentation>; subscriptions: Set<AgentLivePresentationSubscription> }>();
  private readonly presentation = createLivePresentation(() => [this.transcriptRegion()], 50);
  private items: TranscriptItem[];
  private modelContext: AgentModelContextView = { systemPrompt: "", tools: [] };
  private frame: ConversationView;
  private disposed = false;
  private readonly ctx: AgentRenderContext;

  private constructor(private readonly watch: WatchHandle<ConversationView>, ctx: AgentRenderContext, private readonly onCommit?: (view: ConversationView) => void | Promise<void>) {
    this.frame = activeConversationView(watch.value);
    this.items = projectDurableTranscript(this.frame);
    this.markdown = new StreamingTexts(ctx.workspaceId);
    this.ctx = { ...ctx, streamingText: this.markdown.render };
    this.update(this.frame);
    watch.start(onValues(async value => {
      if (this.disposed) return;
      const view = activeConversationView(value);
      this.update(view);
      await this.onCommit?.(view);
    }));
    // A failed observer must be visible to the production owner, not mistaken
    // for an idle agent. `closed` returns the native terminal reason to callers.
    void watch.closed.then(() => this.release());
  }

  static async attach(conversation: Pick<Conversation, "watch" | "context">, ctx: AgentRenderContext, context: Context, onCommit?: (view: ConversationView) => void | Promise<void>) {
    const { head } = await conversation.context(context);
    const watch = await conversation.watch(context, { from: head?.head, min: wholeWindow, max: wholeWindow });
    try { return new DurableAgentPresentation(watch, ctx, onCommit); }
    catch (error) { await watch.stop(); throw error; }
  }

  get state() { return durableViewState(this.frame); }
  get busy(): boolean { return Boolean(this.state.live.run || this.state.live.compactions?.length); }
  get branchId(): string { return this.ctx.branchId!; }
  get closed() { return this.watch.closed; }

  private update(view: ConversationView) {
    this.frame = view;
    const branch = `${view.conversation.id}:${view.entries.find(entry => entry.head !== undefined)?.id ?? "root"}`;
    if (branch !== this.ctx.branchId) {
      this.clearTurns();
      this.markdown.clear();
      this.renderer.clear();
      this.ctx.branchId = branch;
    }
    const model = this.state.agent.model;
    this.ctx.model = model ? { provider: model.provider, id: model.modelId } : undefined;
    this.items = projectDurableTranscript(view);
    // Display committed system deltas, never re-render a mutable prompt loader
    // while reconstructing history. Honor context overrides for these details.
    const edits = new Map(view.entries.flatMap(entry => entry.edits ?? []).map(edit => [edit.target, edit]));
    const messages = view.entries.flatMap(entry => {
      const edit = edits.get(entry.id);
      return edit?.action === "omit" ? [] : edit?.action === "replace" ? edit.messages : entry.model ?? [];
    });
    this.modelContext = { systemPrompt: getCurrentSystemPrompt(messages), tools: getCurrentTools(messages) };
    this.presentation.invalidate();
    for (const channel of this.turns.values()) channel.presentation.invalidate();
    this.markdown.retainLive(this.items);
  }

  private assertOpen() { if (this.disposed) throw new Error("Durable presentation is detached"); }

  transcriptRegion(): LiveRegion {
    this.assertOpen();
    return this.renderer.renderTranscript(this.ctx, this.items, this.modelContext);
  }

  subscribeLivePresentation(listener: AgentLivePresentationListener, shown?: LiveRegionDigests): AgentLivePresentationSubscription {
    this.assertOpen();
    return this.presentation.subscribe(listener, shown);
  }

  subscribeTurnPresentation(turnId: string, branchId: string, listener: AgentLivePresentationListener): AgentLivePresentationSubscription {
    this.assertOpen();
    if (branchId !== this.branchId) throw new Error("Turn subscription belongs to an obsolete branch");
    if (findTranscriptItem(this.items, turnId)?.type !== "working") throw new Error(`Unknown turn: ${turnId}`);
    let channel = this.turns.get(turnId);
    if (!channel) {
      channel = { subscriptions: new Set(), presentation: createLivePresentation(() => {
        const turn = findTranscriptItem(this.items, turnId);
        return turn?.type === "working" ? [this.renderer.renderTurn(this.ctx, turn)] : [];
      }, 50) };
      this.turns.set(turnId, channel);
    }
    const owned = channel;
    const subscription = owned.presentation.subscribe(listener);
    const handle: AgentLivePresentationSubscription = { unsubscribe: () => {
      subscription.unsubscribe();
      owned.subscriptions.delete(handle);
      if (!owned.subscriptions.size) {
        owned.presentation.dispose();
        if (this.turns.get(turnId) === owned) this.turns.delete(turnId);
      }
    } };
    owned.subscriptions.add(handle);
    return handle;
  }

  detailHtml(key: string, count = 100): string {
    this.assertOpen();
    if (key === "system-prompt" || key === "tool-definitions") return renderModelContextDetailFrame(this.ctx, this.modelContext, key);
    const item = findTranscriptItem(this.items, key);
    return item ? renderTranscriptItemDetailFrame(this.ctx, item, { count }) : "";
  }

  revealTurn(target: string): string | undefined {
    this.assertOpen();
    return this.items.find(item => item.type === "working" && item.items.some(child => isTranscriptTarget(child, target)))?.key;
  }

  private clearTurns() {
    for (const channel of this.turns.values()) {
      for (const subscription of [...channel.subscriptions]) subscription.unsubscribe();
      channel.presentation.dispose();
    }
    this.turns.clear();
  }

  private release() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTurns();
    this.presentation.dispose();
    this.markdown.clear();
    this.renderer.clear();
  }

  async dispose(): Promise<void> {
    this.release();
    await this.watch.stop();
  }
}
