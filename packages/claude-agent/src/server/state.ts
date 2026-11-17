import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeBlocks, claudeText, claudeUserIntent, type ClaudeRow } from "./rows.ts";

interface StreamingBlock { type: "text" | "thinking" | "tool_use"; text: string; id?: string; name?: string }

export class ClaudeState {
  rows: ClaudeRow[] = [];
  streaming?: { messageId: string; startedAt: number; blocks: Map<number, StreamingBlock> };
  readonly notices: string[] = [];
  hydrate(rows: ClaudeRow[]) {
    this.rows = rows;
    this.streaming = undefined;
  }
  /**
   * History is canonical, but Claude writes it in batches. Messages already
   * streamed stay until history records them; prompts it never absorbed stay queued.
   */
  merge(history: ClaudeRow[]) {
    const recorded = new Set(history.map(row => row.uuid));
    const commands = history.flatMap(row => {
      const intent = row.kind === "user" ? claudeUserIntent(row) : undefined;
      return intent?.kind === "prompt" && intent.text.startsWith("/") ? [{ text: intent.text, timestamp: row.timestamp }] : [];
    });
    const echoed = (row: ClaudeRow) => {
      const intent = row.kind === "user" ? claudeUserIntent(row) : undefined;
      return intent?.kind === "prompt" && commands.some(command => command.text === intent.text && command.timestamp >= row.timestamp - 2000);
    };
    const runs = new Set(history.flatMap(row => row.kind === "task" ? [row.runId] : []));
    this.rows = [...history, ...this.rows.filter(row => !recorded.has(row.uuid) && !echoed(row) && !(row.kind === "task" && runs.has(row.runId)))];
  }
  add(row: ClaudeRow) {
    if (!this.rows.some(existing => existing.uuid === row.uuid)) this.rows.push(row);
  }
  private committedBlocks(messageId: string) {
    return this.rows.reduce((count, row) => row.kind === "assistant" && row.messageId === messageId ? count + row.content.length : count, 0);
  }
  receive(message: SDKMessage): void {
    if ("parent_tool_use_id" in message && message.parent_tool_use_id !== null) return;
    switch (message.type) {
      case "stream_event": {
        const event = message.event;
        if (event.type === "message_start") this.streaming = { messageId: event.message.id, startedAt: Date.now(), blocks: new Map() };
        else if (event.type === "message_stop") this.streaming = undefined;
        else if (event.type === "content_block_start" && this.streaming) {
          const block = event.content_block;
          if (block.type === "text") this.streaming.blocks.set(event.index, { type: "text", text: block.text });
          else if (block.type === "thinking") this.streaming.blocks.set(event.index, { type: "thinking", text: block.thinking });
          else if (block.type === "tool_use") this.streaming.blocks.set(event.index, { type: "tool_use", text: "", id: block.id, name: block.name });
        } else if (event.type === "content_block_delta" && this.streaming) {
          const block = this.streaming.blocks.get(event.index);
          if (block && event.delta.type === "text_delta") block.text += event.delta.text;
          else if (block && event.delta.type === "thinking_delta") block.text += event.delta.thinking;
        }
        break;
      }
      case "assistant": {
        const content = claudeBlocks(message.message.content);
        if (message.message.model === "<synthetic>" && message.error === undefined) {
          this.add({ kind: "output", uuid: message.uuid, timestamp: Date.now(), text: claudeText(content).trim(), error: false });
          break;
        }
        const position = this.committedBlocks(message.message.id);
        for (const index of content.keys()) this.streaming?.blocks.delete(position + index);
        this.add({ kind: "assistant", uuid: message.uuid, timestamp: Date.now(), messageId: message.message.id, content, stopReason: message.message.stop_reason, usage: message.message.usage, error: message.error !== undefined });
        break;
      }
      case "user":
        if ("isReplay" in message && message.isReplay) break;
        if (message.uuid) this.add({ kind: "user", uuid: message.uuid, timestamp: Date.now(), content: claudeBlocks(message.message.content), meta: message.isSynthetic === true });
        break;
      case "system":
        if (message.subtype === "compact_boundary") this.add({ kind: "compact", uuid: message.uuid, timestamp: Date.now() });
        break;
      case "result":
        this.streaming = undefined;
        break;
    }
  }
}
