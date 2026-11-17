// One-shot agents for code mode scripts, after pi-private's p2 `agent` plugin. `await tools.agent({ prompt, schema })`
// runs a fresh conversation and resolves to its final answer, parsed as JSON and validated against `schema`. Nothing is
// reported to the calling conversation: only the script's return value reaches it.
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { clampThinkingLevel, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineDoc, defineEntry, defineTool, UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { assertDurableToolAdmission, WorkspaceAgents } from "@agents-in-the-cloud/builtin-agent/server";
import { finalAssistantText, unfencedJson } from "@agents-in-the-cloud/agent/server/transcript";
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

export const oneShotAgentToolName = "agent";

export function oneLine(text: string, length: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}
const attempts = 3;
const oneShotTools = ["read", "write", "edit", "bash"];
const thinkingLevels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const OneShotRun = defineDoc<{ conversationId?: ConversationId }>({
  kind: "agents-in-the-cloud.one-shot-run", version: 1, scope: "task", initial: () => ({}), checkpointWhen: () => true,
});

export const oneShotAgentEntry = defineEntry<{ callId: string; agentId: string }>("agents-in-the-cloud.one-shot-agent");

export function createOneShotAgentTool(models: Pick<Models, "getModel">) {
  return defineTool({
    name: oneShotAgentToolName,
    description: `Run a one-shot agent in your cwd and resolve to its final answer, parsed as JSON and validated against \`schema\` (a JSON Schema object). Rejects when the agent fails, or when its answer still does not validate after ${attempts} attempts. Its answer is not reported to you, only what the script returns. Run many at once with \`Promise.all\`. Give each a short \`label\`, absolute paths, and say whether it may change files.`,
    parameters: Type.Object({
      prompt: Type.String({ description: "The task." }),
      label: Type.Optional(Type.String({ description: "Short name shown where the user inspects it; default: the prompt's start." })),
      schema: Type.Record(Type.String(), Type.Unknown(), { description: "JSON Schema of the answer." }),
      model: Type.Optional(Type.String({ description: "'provider/modelId'; default: the caller's." })),
      thinkingLevel: Type.Optional(Type.String({ description: `${thinkingLevels.join("|")}; default: the caller's.` })),
      tools: Type.Optional(Type.Array(Type.String(), { description: `Subset of ${oneShotTools.join(", ")}; default: all.` })),
    }, { additionalProperties: false }),
    structuredOutputSchema: Type.Unknown(),
    callers: ["tools"],
    replay: "safe",
    async execute(args, api, context) {
      const fail = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });
      let validator: ReturnType<typeof Compile>;
      try {
        // SAFETY: TypeBox compiles plain JSON Schema; an invalid one throws here.
        validator = Compile(args.schema as TSchema);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return fail(`Invalid schema: ${error.message}`);
      }
      const existing = await api.snapshot(OneShotRun, api.taskId, context);
      let choice: { model: { provider: string; modelId: string }; thinkingLevel: ModelThinkingLevel; tools: string[] } | undefined;
      if (existing?.conversationId === undefined) {
        const own = await api.agent(context);
        const text = args.model ?? (own.model && `${own.model.provider}/${own.model.modelId}`);
        const slash = text?.indexOf("/") ?? -1;
        const ref = text && slash > 0 ? { provider: text.slice(0, slash), modelId: text.slice(slash + 1) } : undefined;
        const model = ref && models.getModel(ref.provider, ref.modelId);
        if (!ref || !model) return fail(`Unknown model ${args.model ?? "(none)"}. Use 'provider/modelId', such as the caller's.`);
        if (args.thinkingLevel !== undefined && !thinkingLevels.includes(args.thinkingLevel)) return fail(`Invalid thinkingLevel ${args.thinkingLevel}. Choose from ${thinkingLevels.join(", ")}.`);
        // SAFETY: checked against the levels just above.
        const thinkingLevel = clampThinkingLevel(model, (args.thinkingLevel ?? own.thinkingLevel) as ModelThinkingLevel);
        const tools = args.tools ?? oneShotTools;
        const unknown = tools.filter(tool => !oneShotTools.includes(tool));
        if (unknown.length) return fail(`Unknown tools: ${unknown.join(", ")}. Choose from ${oneShotTools.join(", ")}.`);
        choice = { model: ref, thinkingLevel, tools: [...new Set(tools)] };
      }
      // Owned by this call: stopping the script stops the agent. Listed in the same commit, by the call ID the script's
      // card shows it under, so the user can open its transcript.
      const conversationId = await api.commit(async tx => {
        const run = await tx.doc(OneShotRun, api.taskId);
        if (run.conversationId !== undefined) return run.conversationId;
        if (!choice) throw new Error("The agent's record disappeared");
        await assertDurableToolAdmission(tx, api);
        const catalog = await tx.doc(WorkspaceAgents);
        const caller = catalog.agents.find(record => record.durableId === api.conversationId);
        if (!caller) throw new Error("Calling conversation is not the selected branch");
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        const agentId = randomUUID();
        const copied = await tx.doc(AgentDoc, created.id);
        const installed = api.registry.tools();
        const excluded = new Set(installed.filter(({ tool }) => tool.name === CODEMODE_TOOL_NAME || tool.name === oneShotAgentToolName).map(({ extension }) => extension));
        const tools = choice.tools.flatMap(name => installed.filter(({ tool }) => tool.name === name).slice(0, 1).map(({ tool }) => tool));
        await configure(tx, created.id, {
          model: choice.model,
          thinkingLevel: choice.thinkingLevel,
          extensions: { remove: [...excluded] },
          tools,
          instructions: [
            copied.instructions?.replace(`Your AgentsInTheCloud Agent ID is ${JSON.stringify(caller.agentId)}.`, `Your AgentsInTheCloud Agent ID is ${JSON.stringify(agentId)}.`),
            `You are a one-shot agent working for a code mode script. Do the requested work. Your final answer is parsed by the script: it must be only a JSON value matching this JSON Schema, without prose or code fences:\n${JSON.stringify(args.schema)}`,
          ].filter(Boolean).join("\n\n"),
        });
        catalog.agents.push({
          agentId, durableId: created.id, parentId: caller.agentId, rootId: caller.rootId ?? caller.agentId,
          label: oneLine(args.label ?? args.prompt, 80), title: oneLine(args.prompt, 100), readOnly: true, oneShotCallId: api.callId,
        });
        await tx.appendEntry(oneShotAgentEntry, api.conversationId, { data: { callId: api.callId, agentId } });
        run.conversationId = created.id;
        return created.id;
      }, context);
      const ran = async (result: { output: { type: "text"; text: string }[]; isError?: boolean; structuredOutput?: JsonValue }) => {
        const usage = await api.snapshot(UsageDoc, conversationId, context);
        const buckets = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
        return { ...result, details: { usage: {
          outputTokens: buckets.reduce((sum, item) => sum + item.output, 0),
          cost: buckets.reduce((sum, item) => sum + item.cost.total, 0),
        } } };
      };
      const child = await api.conversation(conversationId, context);
      if (!child) return fail("The agent's conversation is gone.");
      let message = args.prompt;
      let problem = "";
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const submission = await child.submit({ type: "input", content: message, whenBusy: "followUp", requestId: `one-shot:${attempt}` }, context);
        const settled = await submission.wait(context);
        if (settled.type !== "input" || settled.status !== "done") return ran(fail(`The agent did not answer: ${settled.reason ?? settled.status}`));
        const answer = await api.commit(tx => tx.entry(settled.answer), context);
        const reply = answer?.model?.findLast(item => item.role === "assistant");
        const text = reply?.role === "assistant" ? finalAssistantText(reply.content) : "";
        let value: JsonValue;
        try {
          // SAFETY: JSON.parse returns JSON values only.
          value = JSON.parse(unfencedJson(text)) as JsonValue;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          problem = `it is not JSON (${error.message})`;
          message = `Your answer was not usable: ${problem}. Reply with only the JSON value.`;
          continue;
        }
        if (validator.Check(value)) return ran({ output: [{ type: "text" as const, text: JSON.stringify(value) }], structuredOutput: value });
        const errors = [...validator.Errors(value)].slice(0, 5).map(error => `${error.instancePath || "/"}: ${error.message}`);
        problem = `it does not match the schema (${errors.join("; ")})`;
        message = `Your answer was not usable: ${problem}. Reply with only the corrected JSON value.`;
      }
      return ran(fail(`The agent's answer was not usable after ${attempts} attempts: ${problem}.`));
    },
  });
}
