import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createRegistry, Harness, UsageDoc } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { durableContextTokens, durableSubscriptionActivity } from "../../src/server/durable-accounting.ts";

const context = BACKGROUND_CONTEXT;
test("native context estimate follows head cutoffs, and derived edits", async () => {
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("answer")]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
    await (await conversation.submit({ type: "input", content: "question", requestId: "one" }, context)).wait(context);
    const view = await conversation.context(context);
    const assistant = view.messages.findLast(message => message.role === "assistant")!;
    expect(assistant.role).toBe("assistant");
    if (assistant.role !== "assistant") throw new Error("Expected assistant");
    expect(durableContextTokens(view)).toBe(calculateContextTokens(assistant.usage));
    const originalUsage = await harness.snapshot(UsageDoc, conversation.id, context);
    expect(Object.keys(originalUsage!.models).length).toBe(1);
    const fork = await conversation.fork(view.entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
    expect(await harness.snapshot(UsageDoc, fork.id, context)).toEqual({ models: {}, tools: {} });
    expect(durableContextTokens(await fork.context(context))).toBe(durableContextTokens(view));
    const head = view.entries.at(-1)!;
    expect(durableContextTokens({ ...view, head })).toBe(view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0));
    expect(durableContextTokens({ ...view, head, messages: [], contributions: view.entries.map(() => []) })).toBe(0);
  } finally { await harness.close(context); }
});

test("subscription pacing hook runs without a presentation mount and ignores API keys/errors", async () => {
  for (const source of ["OAuth", "API Key"] as const) {
    const recorded: string[] = [];
    const registry = createRegistry();
    registry.install(durableSubscriptionActivity({ getAuth: async () => ({ source, auth: { apiKey: "fake" } }) }, provider => { recorded.push(provider); }));
    const models = createModels();
    const faux = fauxProvider({ provider: "openai-codex", tokensPerSecond: 100_000 });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("", { stopReason: "aborted" })]);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    try {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "openai-codex", modelId: "faux-1" } } }, context);
      await (await conversation.submit({ type: "input", content: "question", requestId: "one" }, context)).wait(context);
      await (await conversation.submit({ type: "input", content: "another", requestId: "two" }, context)).wait(context);
      expect(recorded).toEqual(source === "OAuth" ? ["openai-codex"] : []);
    } finally { await harness.close(context); }
  }
});

test("subscription pacing counts OpenCode Go, whose subscription is an API key", async () => {
  const recorded: string[] = [];
  const registry = createRegistry();
  registry.install(durableSubscriptionActivity({ getAuth: async () => ({ source: "API Key", auth: { apiKey: "fake" } }) }, provider => { recorded.push(provider); }));
  const models = createModels();
  const faux = fauxProvider({ provider: "opencode-go", tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("answer")]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "opencode-go", modelId: "faux-1" } } }, context);
    await (await conversation.submit({ type: "input", content: "question", requestId: "one" }, context)).wait(context);
    expect(recorded).toEqual(["opencode-go"]);
  } finally { await harness.close(context); }
});
