import { contentText } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { isToolViewDetails, type SessionImageRef, type TranscriptRecord } from "./transcript.ts";

import { turnStartEntryType, turnStartSchema, turnTimingEntryType, turnTimingRecordSchema } from "./turn-timing.ts";

interface ImageDimensions {
  width: number;
  height: number;
}

function imageDimensions(data: Uint8Array, mimeType: string): ImageDimensions | undefined {
  if (mimeType === "image/png" && data.length >= 24) return { width: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(16), height: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(20) };
  if (mimeType === "image/gif" && data.length >= 10) return { width: data[6]! | data[7]! << 8, height: data[8]! | data[9]! << 8 };
  if (mimeType === "image/bmp" && data.length >= 26) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (mimeType === "image/webp" && data.length >= 30 && String.fromCharCode(...data.slice(12, 16)) === "VP8X") {
    const width = 1 + data[24]! + (data[25]! << 8) + (data[26]! << 16);
    const height = 1 + data[27]! + (data[28]! << 8) + (data[29]! << 16);
    return { width, height };
  }
  if (mimeType === "image/jpeg") {
    for (let offset = 2; offset + 8 < data.length;) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      const length = data[offset + 2]! << 8 | data[offset + 3]!;
      if (marker >= 0xc0 && marker <= 0xc3) return { height: data[offset + 5]! << 8 | data[offset + 6]!, width: data[offset + 7]! << 8 | data[offset + 8]! };
      offset += 2 + length;
    }
  }
  return undefined;
}

const sessionImagePartSchema = Type.Object({
  type: Type.Literal("image"),
  mimeType: Type.Optional(Type.Unknown()),
  data: Type.Optional(Type.Unknown()),
});
const sessionImageStringSchema = Type.String();
const sessionTextSignatureSchema = Type.String();

// Persisted Pi entries are external input. Validate the fields this projection
// reads without requiring unrelated SDK metadata or rejecting older sessions.
const textPartSchema = Type.Object({ type: Type.Literal("text"), text: Type.Optional(Type.String()), textSignature: Type.Optional(Type.Unknown()) });
const assistantPartSchema = Type.Union([
  textPartSchema,
  Type.Object({ type: Type.Literal("thinking"), thinking: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("toolCall"), id: Type.String(), name: Type.String(), arguments: Type.Unknown() }),
]);
const contentSchema = Type.Union([Type.String(), Type.Array(Type.Unknown())]);
const messageSchema = Type.Union([
  Type.Object({ role: Type.Literal("user"), content: contentSchema }),
  Type.Object({ role: Type.Literal("assistant"), content: Type.Optional(Type.Array(Type.Unknown())),
    stopReason: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse"), Type.Literal("error"), Type.Literal("aborted"), Type.Literal("deferred")])),
    errorMessage: Type.Optional(Type.String()),
  }),
  Type.Object({ role: Type.Literal("toolResult"), toolCallId: Type.String(), content: contentSchema, details: Type.Optional(Type.Unknown()), isError: Type.Optional(Type.Boolean()) }),
  Type.Object({ role: Type.Literal("bashExecution"), command: Type.String(), output: Type.Optional(Type.String()) }),
  Type.Object({ role: Type.Literal("custom"), content: contentSchema, display: Type.Boolean() }),
  Type.Object({ role: Type.Literal("branchSummary"), summary: Type.Optional(Type.String()) }),
]);
const entryFields = { id: Type.String(), timestamp: Type.Optional(Type.String()) };
const sessionEntrySchema = Type.Union([
  Type.Object({ ...entryFields, type: Type.Literal("message"), parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])), message: messageSchema }),
  Type.Object({ timestamp: entryFields.timestamp, type: Type.Literal("custom"), customType: Type.String(), data: Type.Optional(Type.Unknown()) }),
  Type.Object({ ...entryFields, type: Type.Literal("branch_summary"), summary: Type.Optional(Type.String()) }),
  Type.Object({ ...entryFields, type: Type.Literal("usage"), kind: Type.String(), note: Type.Optional(Type.String()),
    usage: Type.Object({ input: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), cost: Type.Object({ total: Type.Number() }) }),
  }),
  Type.Object({ ...entryFields, type: Type.Literal("compaction") }),
  Type.Object({ ...entryFields, type: Type.Literal("custom_message"), content: contentSchema, display: Type.Boolean() }),
  Type.Object({ ...entryFields, type: Type.Literal("model_change"), provider: Type.String(), modelId: Type.String() }),
  Type.Object({ ...entryFields, type: Type.Literal("thinking_level_change"), thinkingLevel: Type.String() }),
]);

// Resolve history schemas once, not for every entry and content block on reload.
const sessionImagePartValidator = Compile(sessionImagePartSchema);
const sessionImageStringValidator = Compile(sessionImageStringSchema);
const sessionTextSignatureValidator = Compile(sessionTextSignatureSchema);
const textPartValidator = Compile(textPartSchema);
const assistantPartValidator = Compile(assistantPartSchema);
const sessionEntryValidator = Compile(sessionEntrySchema);
const turnStartValidator = Compile(turnStartSchema);
const turnTimingRecordValidator = Compile(turnTimingRecordSchema);

type CacheWarmUsage = Extract<SessionEntry, { type: "usage" }>["usage"];
function sessionContentText(content: string | readonly unknown[]): string {
  if (sessionImageStringValidator.Check(content)) return content;
  return contentText(content.filter(part => textPartValidator.Check(part)).map(part => ({ type: "text", text: part.text ?? "" })));
}


interface SessionAssistantTextPart {
  type: "text";
  text: string;
  textSignature?: string;
}

function sessionContentImages(entryId: string, content: string | readonly unknown[]): SessionImageRef[] {
  if (sessionImageStringValidator.Check(content)) return [];
  const images: SessionImageRef[] = [];
  content.forEach((part, contentIndex) => {
    if (!sessionImagePartValidator.Check(part)) return;
    const mimeType = sessionImageStringValidator.Check(part.mimeType) ? part.mimeType : undefined;
    const data = sessionImageStringValidator.Check(part.data) ? part.data : undefined;
    const dimensions = data && mimeType ? imageDimensions(Buffer.from(data.slice(0, 87_384), "base64"), mimeType) : undefined;
    images.push({ entryId, contentIndex, mimeType, ...dimensions });
  });
  return images;
}

function entryTimestamp(entry: { timestamp?: string }): number {
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function cacheWarmingNotice(entry: { usage: Pick<CacheWarmUsage, "input" | "cacheRead" | "cacheWrite"> & { cost: Pick<CacheWarmUsage["cost"], "total"> }; note?: string }): string {
  const tokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
  const cost = entry.usage.cost.total.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
  const note = entry.note ? ` (${entry.note})` : "";
  return `Cache warmed${note} · ${tokens.toLocaleString("en-US")} tokens · $${cost}`;
}

export function recordsFromSessionEntries(entries: readonly unknown[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  let lastSettingChange: { type: "model_change" | "thinking_level_change"; record: TranscriptRecord } | undefined;
  for (const entry of entries) {
    if (!sessionEntryValidator.Check(entry)) continue;
    if (entry.type === "custom" && entry.customType === turnStartEntryType && turnStartValidator.Check(entry.data)) {
      records.push({ kind: "runStart", ...entry.data, timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "custom" && entry.customType === turnTimingEntryType && turnTimingRecordValidator.Check(entry.data)) {
      const { turnEntryId, outcome, ...timing } = entry.data;
      records.push({ kind: "timing", timing, turnEntryId, outcome, timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        records.push({ kind: "user", id: entry.id, text: sessionContentText(message.content), images: sessionContentImages(entry.id, message.content), timestamp: entryTimestamp(entry), rewindable: entry.parentId !== null && entry.parentId !== undefined });
      } else if (message.role === "assistant") {
        const parts: Extract<TranscriptRecord, { kind: "assistant" }>["parts"] = [];
        for (const part of message.content ?? []) {
          if (!assistantPartValidator.Check(part)) continue;
          if (part.type === "thinking") parts.push({ type: "thinking", text: part.thinking ?? "" });
          else if (part.type === "text") {
            const textPart: SessionAssistantTextPart = { type: "text", text: part.text ?? "" };
            if (sessionTextSignatureValidator.Check(part.textSignature)) textPart.textSignature = part.textSignature;
            parts.push(textPart);
          }
          else if (part.type === "toolCall") parts.push({ type: "toolCall", callId: part.id, name: part.name, args: part.arguments });
        }
        records.push({
          kind: "assistant",
          id: entry.id,
          parts,
          stopReason: message.stopReason ?? "stop",
          errorMessage: message.errorMessage,
          timestamp: entryTimestamp(entry),
        });
      } else if (message.role === "toolResult") {
        const details = isToolViewDetails(message.details) ? message.details : undefined;
        records.push({ kind: "toolResult", callId: message.toolCallId, text: sessionContentText(message.content), images: sessionContentImages(entry.id, message.content), isError: Boolean(message.isError), timestamp: entryTimestamp(entry), details });
      } else if (message.role === "bashExecution") {
        records.push({ kind: "note", id: entry.id, text: `\`$ ${message.command}\`\n\n\`\`\`\n${message.output ?? ""}\n\`\`\``, tone: "system", timestamp: entryTimestamp(entry) });
      } else if (message.role === "custom" && message.display) {
        records.push({ kind: "note", id: entry.id, text: sessionContentText(message.content), tone: "summary", timestamp: entryTimestamp(entry) });
      } else if (message.role === "branchSummary") {
        records.push({ kind: "note", id: entry.id, text: `**Rewound** — summary of the abandoned branch:\n\n${message.summary ?? ""}`, tone: "summary", timestamp: entryTimestamp(entry) });
      }
      continue;
    }
    if (entry.type === "branch_summary") {
      records.push({ kind: "note", id: entry.id, text: `**Rewound** — summary of the abandoned branch:\n\n${entry.summary ?? ""}`, tone: "summary", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "usage" && entry.kind === "cache_warm") {
      records.push({ kind: "note", id: entry.id, text: cacheWarmingNotice(entry), tone: "system", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "compaction") {
      records.push({ kind: "note", id: entry.id, text: "Context compacted", tone: "system", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "custom_message" && entry.display) {
      records.push({ kind: "note", id: entry.id, text: sessionContentText(entry.content), tone: "summary", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "model_change" || entry.type === "thinking_level_change") {
      if (records.length === 0) continue;
      const text = entry.type === "model_change" ? `model → ${entry.provider}/${entry.modelId}` : `Thinking level → ${entry.thinkingLevel}`;
      const record: TranscriptRecord = { kind: "note", id: entry.id, text, tone: "system", timestamp: entryTimestamp(entry) };
      if (lastSettingChange && lastSettingChange.type === entry.type && records.at(-1) === lastSettingChange.record) records[records.length - 1] = record;
      else records.push(record);
      lastSettingChange = { type: entry.type, record };
      continue;
    }
  }
  return records;
}
