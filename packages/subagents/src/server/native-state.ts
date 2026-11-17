import { finalAssistantTextIndexes, finalAssistantText, isFinalAssistantMessage } from "@agents-in-the-cloud/agent/server/transcript";
import { defineDoc, defineEntry, type ConversationId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";
import { type Message, type TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const maxConcurrentSubagents = 6;
export const anchorTaskName = "agents-in-the-cloud.delegation-anchor";
export type Receipt = {
  id: string; from: string; to: string; author: string; recipient: string;
  conversationId: ConversationId; senderConversationId: ConversationId;
  kind: "task" | "message" | "completion"; text: string; timestamp: number;
  callId?: string; sourceEntry?: number;
  handling: "idle-task" | "idle-message" | "working" | "waiting";
  context: "pending" | "queued" | "placed" | "failed"; error?: string;
  prepared?: { timestamp: number; format: string };
};
export const inheritedBoundaryEntry = defineEntry<{ source: string; count: number }>("agents-in-the-cloud.inherited-boundary");
export const communicationEntry = defineEntry<{ direction: "incoming" | "outgoing"; receipt: Receipt }>("agents-in-the-cloud.communication");
export const communicationStateEntry = defineEntry<{ id: string; change: Partial<Receipt> }>("agents-in-the-cloud.communication-state");
export const Delegation = defineDoc<{
  receipts: Record<string, Receipt>;
  assignments: Record<string, { recipient: ConversationId; status: "pending" | "completed" | "failed" | "interrupted"; result?: string }>;
  operations: Record<string, { child?: string; previous?: import("@earendil-works/chord").JsonValue }>;
}>({ kind: "agents-in-the-cloud.delegation", version: 1, scope: "session", initial: () => ({ receipts: {}, assignments: {}, operations: {} }), checkpointWhen: () => false, });
export const Mailbox = defineDoc<{ receipts: Receipt[] }>({ kind: "agents-in-the-cloud.mailbox", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ receipts: [] }), checkpointWhen: () => false, });

export async function updateReceipt(tx: Tx, id: string, change: Partial<Receipt>) {
  const receipt = (await tx.doc(Delegation)).receipts[id]!;
  Object.assign(receipt, change);
  Object.assign((await tx.doc(Mailbox, receipt.conversationId)).receipts.find(item => item.id === id)!, change);
  await tx.appendEntry(communicationStateEntry, receipt.conversationId, { data: { id, change } });
}

const attributedSchema = Type.Object({
  type: Type.Literal("text"), text: Type.String(),
  agentsInTheCloudAgentMessage: Type.Object({ id: Type.String(), conversationId: Type.Number(), requestConversationId: Type.Optional(Type.Number()), author: Type.String(), recipient: Type.String(), kind: Type.Union([Type.Literal("task"), Type.Literal("message"), Type.Literal("completion")]) }),
});
export const attributedMessagesSchema = Type.Array(Type.Object({ role: Type.Literal("user"), timestamp: Type.Number(), content: Type.Array(attributedSchema) }));
export type AttributedText = TextContent & { agentsInTheCloudAgentMessage: { id: string; conversationId: ConversationId; requestConversationId?: ConversationId; author: string; recipient: string; kind: Receipt["kind"] } };
export function attribution(message: Message) {
  if (message.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) return undefined;
  const part = message.content[0];
  if (!Value.Check(attributedSchema, part)) return undefined;
  // SAFETY: The schema checks every field; the branded ID was written by journal admission.
  return part as AttributedText;
}
export function envelope(receipt: Receipt) {
  return `Message Type: ${receipt.kind === "task" ? "NEW_TASK" : receipt.kind === "completion" ? "FINAL_ANSWER" : "MESSAGE"}\nTask name: ${receipt.recipient}\nSender: ${receipt.author}\nPayload:\n${receipt.text}`;
}
export function attributedContent(receipt: Receipt): AttributedText[] {
  return [{ type: "text", text: envelope(receipt), agentsInTheCloudAgentMessage: { id: receipt.id, conversationId: receipt.conversationId, author: receipt.author, recipient: receipt.recipient, kind: receipt.kind } }];
}
export function attributedEntry(entry: EntryRecord) {
  const marked = entry.model?.flatMap(message => attribution(message) ?? [])[0];
  return marked ? marked.agentsInTheCloudAgentMessage.kind === "task" ? "task" as const : "message" as const : undefined;
}

export function selectNativeForkHistory(messages: readonly Message[], mode = "all"): Message[] {
  if (mode === "none") return [];
  let selected = messages;
  if (mode !== "all") {
    const boundaries = messages.flatMap((message, index) => {
      const part = attribution(message);
      return message.role === "user" && (!part || part.agentsInTheCloudAgentMessage.kind === "task") ? [index] : [];
    });
    if (!boundaries.length) return [];
    selected = messages.slice(boundaries.at(-Number(mode)) ?? boundaries[0]);
  }
  return selected.flatMap((message): Message[] => {
    if (attribution(message)) return [];
    if (message.role === "user") return [structuredClone(message)];
    if (message.role !== "assistant" || !isFinalAssistantMessage(message.content, message.stopReason)) return [];
    const content = finalAssistantTextIndexes(message.content).map(index => message.content[index]!);
    return content.length ? [structuredClone({ ...message, content })] : [];
  });
}
export function finalText(messages: readonly Message[]) {
  const answer = messages.findLast(message => message.role === "assistant");
  return answer ? finalAssistantText(answer.content) : "";
}
