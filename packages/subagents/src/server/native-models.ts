import { isJsonObject } from "@agents-in-the-cloud/core";
import type { Message, Models } from "@earendil-works/pi-ai";
import { GenerationTask, hook, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { attribution, Delegation, updateReceipt } from "./native-state.ts";
import { SubagentModelInput } from "./subagent-model-input.ts";
import { withStreamSimple } from "@agents-in-the-cloud/builtin-agent/server";

/** Request identity is ephemeral. A history fork may replay an ancestor's message,
 * but must never drain that ancestor's mailbox or rewrite its delivery evidence. */
export function stampDelegationRequestIdentity(messages: readonly Message[], conversationId: ConversationId): Message[] {
  return messages.map(message => {
    const part = attribution(message);
    if (!part) return message;
    return { ...message, content: [{ ...part, agentsInTheCloudAgentMessage: { ...part.agentsInTheCloudAgentMessage, requestConversationId: conversationId } }] };
  });
}

export const delegationRequestIdentity = hook(GenerationTask, {
  beforeRequest(request, api) {
    return { messages: stampDelegationRequestIdentity(request.messages, api.conversationId) };
  },
});

export function delegationModels(models: Models, harness: () => Harness): Models {
  const streamSimple: Models["streamSimple"] = (model, request, options) => {
    const bridge = new SubagentModelInput();
    const delivered = request.messages.flatMap(message => {
      const part = attribution(message);
      return part ? [part.agentsInTheCloudAgentMessage] : [];
    });
    const messages = request.messages.map(message => {
      const part = attribution(message);
      if (!part) return message;
      return bridge.forModel({ type: "agent_message", author: part.agentsInTheCloudAgentMessage.author, recipient: part.agentsInTheCloudAgentMessage.recipient, content: [{ type: "input_text", text: part.text }] }, model.api, message.timestamp);
    });
    return models.streamSimple(model, { ...request, messages }, {
      ...options,
      async onPayload(payload, selected) {
        const previous = await options?.onPayload?.(payload, selected);
        const wire = JSON.parse(JSON.stringify(previous ?? payload));
        if (!isJsonObject(wire)) throw new Error("Expected a provider request object");
        const transformed = bridge.transform(wire, model.api);
        if (delivered.length) await harness().commit(async tx => {
          const ledger = await tx.doc(Delegation);
          for (const marker of delivered) {
            const receipt = ledger.receipts[marker.id];
            if (!receipt || marker.requestConversationId !== marker.conversationId || receipt.conversationId !== marker.conversationId || receipt.prepared) continue;
            await updateReceipt(tx, receipt.id, { prepared: { timestamp: Date.now(), format: model.api === "openai-codex-responses" ? "agent_message" : "user envelope" } });
          }
        }, options?.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
        return transformed;
      },
    });
  };
  return withStreamSimple(models, streamSimple);
}
