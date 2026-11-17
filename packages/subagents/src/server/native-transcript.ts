import { type AgentTranscriptAnchor, type AgentTranscriptSnapshot } from "@agents-in-the-cloud/agent/server/transcript-contributions";
import type { ConversationView } from "@earendil-works/pi-durable";
import { inheritedBoundaryEntry, communicationEntry, communicationStateEntry, type Receipt } from "./native-state.ts";

export function nativeDelegationTranscript(view: Pick<ConversationView, "entries">): AgentTranscriptSnapshot {
  const incoming = new Map<string, Receipt>();
  const sent: Receipt[] = [];
  for (const entry of view.entries) {
    if (communicationEntry.is(entry)) {
      if (entry.data.direction === "incoming") incoming.set(entry.data.receipt.id, structuredClone(entry.data.receipt));
      else sent.push(entry.data.receipt);
    }
    if (communicationStateEntry.is(entry) && incoming.has(entry.data.id)) Object.assign(incoming.get(entry.data.id)!, entry.data.change);
  }
  const inherited = view.entries.find(inheritedBoundaryEntry.is);
  const dispatch = (receipt: Receipt) => sent.findLast(task => task.kind === "task" && task.to === receipt.from && task.timestamp <= receipt.timestamp)?.callId;
  const messages = [...incoming.values()].map(receipt => ({ receipt, dispatch: dispatch(receipt) }));
  return { inheritedContext: inherited ? { boundaryEntryId: String(inherited.id), source: inherited.data.source } : undefined, anchors: sent.flatMap<AgentTranscriptAnchor>(receipt => receipt.callId ? [{ anchor: receipt.id, target: { toolCallId: receipt.callId } }]  : receipt.sourceEntry === undefined ? [] : [{ anchor: receipt.id, target: { entryId: String(receipt.sourceEntry) } }]), messages: messages.map(({ receipt, dispatch }) => ({
    type: "message", key: receipt.id, anchor: receipt.id, timestamp: receipt.timestamp,
    sender: receipt.author, title: receipt.kind, bodyMarkdown: receipt.text, dispatchedByToolCallId: dispatch,
    senderActivityKey: dispatch ? receipt.from : undefined,
    details: {
      Handling: receipt.handling === "idle-task" ? "Starts a turn" : receipt.handling === "idle-message" ? "Waits for the next turn" : receipt.handling === "waiting" ? "Wakes the agent’s wait" : "Queued for the next model boundary",
      Context: receipt.prepared ? `Prepared as ${receipt.prepared.format} · not a read receipt` : receipt.context === "failed" ? receipt.error! : "Pending model context",
    },
  })) };
}
