import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { communicationEntry, type Receipt } from "../../src/server/native-state.ts";
import { nativeDelegationTranscript } from "../../src/server/native-transcript.ts";

test("a message links to the call that gave its sender its latest task", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
    const receipt = (id: string, from: string, kind: Receipt["kind"], timestamp: number, callId?: string): Receipt => ({
      id, from, to: from === "root" ? "child" : "root", author: from, recipient: "root", conversationId: conversation.id, senderConversationId: conversation.id,
      kind, text: id, timestamp, callId, handling: "working", context: "placed",
    });
    await harness.commit(async tx => {
      for (const [direction, data] of [
        ["outgoing", receipt("spawn", "root", "task", 1, "call_spawn")],
        ["outgoing", receipt("nudge", "root", "message", 2, "call_nudge")],
        ["incoming", receipt("progress", "child", "message", 3)],
        ["outgoing", receipt("followup", "root", "task", 4, "call_followup")],
        ["incoming", receipt("done", "child", "completion", 5)],
        ["incoming", receipt("hello", "sibling", "message", 6)],
      ] as const) await tx.appendEntry(communicationEntry, conversation.id, { data: { direction, receipt: data } });
    }, context);
    expect(nativeDelegationTranscript(await conversation.context(context)).messages.map(message => [message.key, message.dispatchedByToolCallId, message.senderActivityKey])).toEqual([
      ["progress", "call_spawn", "child"], ["done", "call_followup", "child"], ["hello", undefined, undefined],
    ]);
  } finally {
    await harness.close(context);
  }
});
