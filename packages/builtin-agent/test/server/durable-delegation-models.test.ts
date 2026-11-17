import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, normalizeContext, type Models, type Model, type SimpleStreamOptions, type UserMessage } from "@earendil-works/pi-ai";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { isJsonObject, type JsonObject } from "@agents-in-the-cloud/core";
import { Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { delegationModels, delegationRequestIdentity } from "../../../subagents/src/server/native-models.ts";
import { Delegation, Mailbox, communicationStateEntry, type Receipt } from "../../../subagents/src/server/native-state.ts";
import type { AgentMessageInput } from "../../../subagents/src/server/subagent-protocol.ts";

const envelope = "Message Type: MESSAGE\nTask name: /root\nSender: /root/review\nPayload:\nReview finished";
const native: AgentMessageInput = { type: "agent_message", author: "/root/review", recipient: "/root", content: [{ type: "input_text", text: envelope }] };
const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "spike" } })).toString("base64url")}.x`;

for (const api of ["openai-codex-responses", "anthropic-messages"] as const) {
  test(`Durable persisted attribution reaches ${api} serializer across reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-delegation-spike-"));
    const captured: JsonObject[] = [];
    const sessionIds: (string | undefined)[] = [];
    let networkCalls = 0;
    const model: Model<typeof api> = { id: api === "anthropic-messages" ? "claude-sonnet-4-20250514" : "gpt-5.4", name: "Spike", provider: "spike", api, baseUrl: "https://never-contact.invalid", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const base = createModels();
    const overrides: Pick<Models, "getModel" | "streamSimple"> = {
      getModel: () => model,
      streamSimple(_model, context, originalOptions) {
        sessionIds.push(originalOptions?.sessionId);
        const options: SimpleStreamOptions = {
          ...originalOptions,
          apiKey: api === "openai-codex-responses" ? token : "inspection-only",
          async onPayload(payload, selected) {
            const transformed = await originalOptions?.onPayload?.(payload, selected);
            const wire = JSON.parse(JSON.stringify(transformed ?? payload));
            if (!isJsonObject(wire)) throw new Error("Expected serialized object");
            captured.push(wire);
            throw new Error("SPIKE_STOP_AFTER_SERIALIZATION");
          },
          fetch: Object.assign(async () => { networkCalls++; throw new Error("Network forbidden"); }, { preconnect() {} }),
        };
        const result = api === "openai-codex-responses"
          ? codexStream({ ...model, api, compat: undefined }, normalizeContext(context), options)
          : anthropicStream({ ...model, api, compat: undefined }, normalizeContext(context), options);
        return result;
      },
    };
    const models = delegationModels(Object.assign(base, overrides), () => harness);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "request-identity", hooks: [delegationRequestIdentity] }));
    const open = async () => Harness.open(await openNodeJsonlStorage(directory, ctx, { fsync: true }), { models, registry, settings: { retry: { enabled: false } } }, ctx);
    let harness = await open();
    try {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "spike", modelId: model.id } } }, ctx);
      const receipt: Receipt = { id: "receipt-1", from: "child", to: "root", author: native.author, recipient: native.recipient, conversationId: conversation.id, senderConversationId: conversation.id, kind: "message", text: "Review finished", timestamp: 42, handling: "idle-message", context: "placed" };
      await harness.commit(async tx => {
        (await tx.doc(Delegation)).receipts[receipt.id] = receipt;
        (await tx.doc(Mailbox, conversation.id)).receipts.push(receipt);
      }, ctx);
      const part = { type: "text" as const, text: envelope, agentsInTheCloudAgentMessage: { id: "receipt-1", conversationId: conversation.id, author: native.author, recipient: native.recipient, kind: "message" } };
      const attributed: UserMessage = { role: "user", timestamp: 42, content: [part] };
      await conversation.submit({ type: "write", entry: { kind: "agents-in-the-cloud.agent-message", data: { receiptId: "receipt-1" }, model: [attributed] } }, ctx);
      const id = conversation.id;
      const head = (await conversation.entries({}, 1, undefined, ctx)).items[0]!;
      const branch = await conversation.fork(head.id, { ownership: { kind: "ownerless" } }, ctx);
      await (await branch.submit({ type: "input", content: envelope, requestId: "fork-request" }, ctx)).wait(ctx);
      expect((await harness.snapshot(Delegation, ctx))?.receipts[receipt.id]?.prepared).toBeUndefined();

      await (await conversation.submit({ type: "input", content: envelope, requestId: "first" }, ctx)).wait(ctx);
      await harness.close(ctx);
      harness = await open();
      const reopened = (await harness.conversation(id, ctx))!;
      await (await reopened.submit({ type: "input", content: "Retry after reopen", requestId: "second" }, ctx)).wait(ctx);
      expect(captured).toHaveLength(3);
      // Durable supplies a persisted provider UUID, and the production delegation
      // adapter preserves it. A fork has its own affinity; reopen keeps the root's.
      expect(sessionIds).toHaveLength(3);
      for (const sessionId of sessionIds) {
        expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
      expect(sessionIds[0]).not.toBe(sessionIds[1]);
      expect(sessionIds[2]).toBe(sessionIds[1]);
      if (api === "openai-codex-responses") {
        for (const [index, payload] of captured.entries()) {
          expect(payload.prompt_cache_key === sessionIds[index]).toBe(true);
        }
      }
      for (const payload of captured) {
        expect(JSON.stringify(payload)).not.toContain("agents-in-the-cloud-agent-message:");
        expect(JSON.stringify(payload)).not.toContain("agentsInTheCloudAgentMessage");
        expect(JSON.stringify(payload)).not.toContain("requestConversationId");
        if (api === "openai-codex-responses") {
          if (!Array.isArray(payload.input)) throw new Error("Expected Responses input");
          const input = payload.input.filter(isJsonObject);
          expect(input.filter(item => item.type === "agent_message")).toEqual([native]);
          expect(input.some(item => item.role === "user" && JSON.stringify(item).includes("Review finished"))).toBe(true);
        } else {
          expect(JSON.stringify(payload.messages)).toContain("Review finished");
          expect(JSON.stringify(payload)).not.toContain('"type":"agent_message"');
        }
      }
      expect((await harness.snapshot(Delegation, ctx))?.receipts[receipt.id]?.prepared?.format).toBe(api === "openai-codex-responses" ? "agent_message" : "user envelope");
      const preparation = (await reopened.entries({}, 100, undefined, ctx)).items.filter(communicationStateEntry.is);
      expect(preparation).toHaveLength(1);
      expect(networkCalls).toBe(0);
    } finally {
      await harness.close(ctx);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
