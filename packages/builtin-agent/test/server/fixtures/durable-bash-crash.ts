import { join } from "node:path";
import { shellQuote } from "@agents-in-the-cloud/core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { createDurableBashExtension } from "../../../src/server/durable-bash.ts";
import { openDurableWorkspace } from "../../../src/server/durable-workspace.ts";
import { terminalProcessesIn } from "../../../../observable-terminal/test/support/local-terminal-processes.ts";

const [path, moment] = process.argv.slice(2);
const processes = terminalProcessesIn(path!);
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100_000 });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", {
  command: `echo once >> ${shellQuote(join(path!, "count"))}; sleep 1; echo recovered`, timeout: 10,
})], { stopReason: "toolUse" })]);
const registry = createRegistry();
registry.install(createDurableBashExtension("workspace", {
  ...processes,
  async start(options) {
    if (moment === "after-start") await processes.start(options);
    process.stdout.write("crash now\n");
    await new Promise(() => {});
  },
}));
const workspace = await openDurableWorkspace(join(path!, "journal"), "workspace", { models, registry });
const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Bash recovery" }, { model: { provider: "faux", modelId: "faux-1" } });
await conversation.submit({ type: "input", content: "Run", requestId: "one" }, BACKGROUND_CONTEXT);
setInterval(() => {}, 60_000);
