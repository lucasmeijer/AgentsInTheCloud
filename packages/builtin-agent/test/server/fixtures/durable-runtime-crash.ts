import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type AgentChange } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { openDurableAgentRuntime } from "../../../src/server/durable-runtime.ts";

const [journal] = process.argv.slice(2);
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100_000 });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" })]);
const registry = createRegistry();
registry.install(defineExtension({ name: "crash-probe", tools: [defineTool({
  name: "probe", description: "Crashes the app", parameters: Type.Object({}), replay: "safe",
  async execute() {
    process.stdout.write("crash now\n");
    return await new Promise<never>(() => {});
  },
})] }));
const runtime = await openDurableAgentRuntime(journal!, "native-workspace", {}, {
  harness: async () => ({ models, registry }),
  prepare: async (): Promise<AgentChange> => ({ model: { provider: "faux", modelId: "faux-1" }, instructions: "Crash", thinkingLevel: "off" }),
  expand: async (_workspace: string, text: string) => text,
  validateModel: async () => {},
  ready: async () => {},
});
const agent = await runtime.agent({ agentId: "tab", label: "Agent 1", title: "Native runtime" });
await agent.submit({ requestId: "crash", text: "Run the probe" });
setInterval(() => {}, 60_000);
