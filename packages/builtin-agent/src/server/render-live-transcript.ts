import { escapeHtml, liveCollection, type LiveRegion } from "@agents-in-the-cloud/shared";
import { commentaryContext, ids, type AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import { renderModelContextEntries, renderTranscriptItem, renderWorkingSection, workingCommentaryItems, workingItemsLoadLazily, type AgentModelContextView } from "@agents-in-the-cloud/agent/server/render-transcript";
import type { TranscriptItem, WorkingTranscriptItem } from "@agents-in-the-cloud/agent/server/transcript";
import { StreamingMarkdownRenderer } from "@agents-in-the-cloud/markdown";

export class StreamingTexts {
  private readonly messages = new Map<string, { source: string; renderer: StreamingMarkdownRenderer; stableHtml: string; tailHtml: string; tailBlocks?: readonly string[] }>();
  constructor(private readonly workspaceId: string) {}

  readonly render: NonNullable<AgentRenderContext["streamingText"]> = (key, source) => {
    let cached = this.messages.get(key);
    if (!cached || !source.startsWith(cached.source)) {
      cached = { source: "", renderer: new StreamingMarkdownRenderer(this.workspaceId), stableHtml: "", tailHtml: "" };
      this.messages.set(key, cached);
    }
    if (source !== cached.source) {
      const update = cached.renderer.render(source);
      cached.source = source;
      cached.stableHtml += update.stableHtmlAddition;
      cached.tailHtml = update.tailHtml;
      cached.tailBlocks = update.tailBlocks;
    }
    return cached;
  };

  retainLive(items: readonly TranscriptItem[]): void {
    const live = new Set<string>();
    const collect = (list: readonly TranscriptItem[]) => { for (const item of list) {
      if (item.type === "text" && item.live) live.add(item.key);
      if (item.type === "working") collect(item.items);
    } };
    collect(items);
    for (const key of this.messages.keys()) if (!live.has(key)) this.messages.delete(key);
  }

  clear(): void { this.messages.clear(); }
}

export class LiveTranscriptRenderer {
  private readonly cache = new Map<string, { fingerprint: string; html: string }>();
  clear(): void { this.cache.clear(); }

  private rows(ctx: AgentRenderContext, items: readonly TranscriptItem[]) {
    return items.map(item => {
      const children: LiveRegion[] = [];
      let commentaryIslands: string | undefined;
      let itemIslands: string | undefined;
      if (item.type === "working") {
        const commentary = commentaryContext(ctx);
        const collection = liveCollection(ids.workingItems(commentary, item.key), this.rows(commentary, workingCommentaryItems(item)));
        commentaryIslands = collection.html;
        children.push(collection);
        if (ctx.inlineWorkingItems && !ctx.readOnly && !workingItemsLoadLazily(ctx, item)) {
          const items = liveCollection(ids.workingItems(ctx, item.key), this.rows(ctx, item.items));
          itemIslands = items.html;
          children.push(items);
        }
      }
      const rendering = item.type === "text" && item.live && !(item.final && ctx.jsonFinalAnswers) && ctx.streamingText ? ctx.streamingText(item.key, item.text) : undefined;
      const key = ids.item(ctx, item.key);
      const fingerprint = item.type === "working" ? undefined : JSON.stringify(rendering ? { ...item, text: "" } : item);
      const cached = this.cache.get(key);
      const html = fingerprint !== undefined && cached?.fingerprint === fingerprint ? cached.html
        : item.type === "working" && commentaryIslands !== undefined ? renderWorkingSection(ctx, item, commentaryIslands, itemIslands)
        : renderTranscriptItem(rendering ? { ...ctx, streamingText: () => ({ stableHtml: "", tailHtml: "" }) } : ctx, item);
      if (fingerprint !== undefined) this.cache.set(key, { fingerprint, html });
      if (rendering) children.push(
        { target: ids.itemTextStable(ctx, item.key), html: rendering.stableHtml, appendOnly: true },
        { target: ids.itemTextTail(ctx, item.key), html: rendering.tailHtml, blocks: rendering.tailBlocks },
      );
      return { id: `${ids.item(ctx, item.key)}_region`, html, children };
    });
  }

  renderTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView): LiveRegion {
    return this.renderRows(ctx, items, renderModelContextEntries(ctx, modelContext));
  }

  renderRows(ctx: AgentRenderContext, items: readonly TranscriptItem[], contextHtml: string): LiveRegion {
    const region = liveCollection(ids.transcript(ctx), [{ id: `${ids.transcript(ctx)}_context`, html: contextHtml }, ...this.rows(ctx, items)]);
    region.html += this.noticesMount(ctx);
    return region;
  }

  private noticesMount(ctx: AgentRenderContext): string {
    return `<div id="${escapeHtml(ids.notices(ctx))}" class="agent-notices" data-turbo-permanent></div>`;
  }

  renderTurn(ctx: AgentRenderContext, turn: WorkingTranscriptItem): LiveRegion {
    return liveCollection(ids.workingItems(ctx, turn.key), this.rows(ctx, turn.items));
  }

}
