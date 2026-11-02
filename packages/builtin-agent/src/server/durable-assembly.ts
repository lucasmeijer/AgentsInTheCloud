import { agentDelegation } from "./delegation.ts";
import { builtinAgentIntegrations } from "./integrations.ts";
import { durableTiming, type WriteDurableTiming } from "./durable-timing.ts";
import { durableSubscriptionActivity } from "./durable-accounting.ts";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, type AgentChange, type Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { createPiModelRuntime } from "@agents-in-the-cloud/llm/server";
import { workspaceRoot } from "@agents-in-the-cloud/workspace";
import { createDurableWorkspaceTools } from "./durable-tools.ts";
import { createDurableBashExtension } from "./durable-bash.ts";
import { createCodemodeTemplates } from "./durable-codemode-templates.ts";
import { listPromptTemplates } from "@agents-in-the-cloud/agent/server/prompt-templates";
import { durableJournalInstructions } from "./durable-storage.ts";
import { formatProjectInstructions, loadWorkspaceAgentsFiles } from "@agents-in-the-cloud/agent/server/workspace-agents-files";
import { loadWorkspaceSkills } from "@agents-in-the-cloud/agent/server/skills";
import { agentsInTheCloudSystemPrompt, prepareAppendedAgentsInTheCloudInstructions } from "@agents-in-the-cloud/agent/server/system-prompt";
import { launchComposerThinkingSettings, resolveNewWorkspaceAgentModel } from "@agents-in-the-cloud/agent/server/model-state";
import type { WorkspaceAgentToolOptions } from "@agents-in-the-cloud/agent/server/tools";

/** Workspace-scoped code, including the task definitions needed to recover bash; integrations add their own. */
export function createDurableWorkspaceRegistry(workspaceId: string, options: WorkspaceAgentToolOptions = {}) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "agents-in-the-cloud.workspace-tools", tools: createDurableWorkspaceTools(workspaceId, options) }));
  registry.install(createDurableBashExtension(workspaceId));
  return registry;
}

/** No AgentSession, delegation coordinator, or host-local filesystem environment. */
/** Our Harness always gets one `Models`, never a function returning the current one. */
export type DurableHarnessOptions = HarnessOptions & { models: Models };

export async function createDurableHarnessOptions(workspaceId: string, options: WorkspaceAgentToolOptions, writeTiming: WriteDurableTiming, harness: () => Harness): Promise<DurableHarnessOptions> {
  const models = await createPiModelRuntime();
  const registry = createDurableWorkspaceRegistry(workspaceId, options);
  const delegation = agentDelegation?.create(models, harness);
  if (delegation) registry.install(delegation.extension);
  // Such as code mode, whose task definitions must be installed to recover its scripts.
  for (const integration of builtinAgentIntegrations()) if (integration.extension) registry.install(integration.extension(workspaceId, models));
  registry.install(durableSubscriptionActivity(models));
  registry.install(durableTiming(writeTiming));
  const templates = createCodemodeTemplates(() => listPromptTemplates(workspaceId), harness);
  registry.install(templates.extension);
  return {
    models: templates.models(delegation?.models ?? models),
    registry,
    settings: { compaction: { enabled: true, keepRecentTokens: 6000 } },
    // Faulted, interrupted and unmigratable tasks, and failing extension code, are otherwise invisible.
    onReport: ({ error, ...info }) => console.error(`Agent work report (${info.kind})`, error, info),
  };
}

/** Only the builtin Agent runs code mode templates, so only its prompt points at their guide. */
const codemodeTemplatesInstructions = "Code mode templates are Prompt templates that run a code mode script as your own call, without asking the model. When the user asks about them or wants one, read /opt/agents-in-the-cloud/docs/codemode-templates.md, which adds to the Prompt templates section of agents-in-the-cloud.md.";

const resourceLoaders = {
  agents: loadWorkspaceAgentsFiles,
  skills: loadWorkspaceSkills,
  model: resolveNewWorkspaceAgentModel,
  thinking: launchComposerThinkingSettings,
};

/**
 * Prepare outside the journal commit; pass the result to workspace.agent().
 * The resulting prompt/model are committed with creation, not rebuilt on recovery
 * from potentially changed workspace files or the host's current model default.
 * Existing conversations keep their settings; explicit refresh uses configure().
 */
export async function prepareDurableAgent(
  workspaceId: string,
  agentId: string,
  options: WorkspaceAgentToolOptions = {},
  initial: Pick<AgentChange, "model" | "thinkingLevel"> = {},
  load: typeof resourceLoaders = resourceLoaders,
): Promise<AgentChange> {
  const [agents, skills, model, appended] = await Promise.all([
    load.agents(workspaceId),
    load.skills(workspaceId),
    initial.model !== undefined ? Promise.resolve(undefined) : load.model(),
    prepareAppendedAgentsInTheCloudInstructions(options.events, workspaceId, agentId),
  ]);
  const selectedModel = initial.model !== undefined ? initial.model : model ? { provider: model.provider, modelId: model.id } : undefined;
  const thinking = initial.thinkingLevel !== undefined ? initial.thinkingLevel
    : (await load.thinking(selectedModel ? { provider: selectedModel.provider, id: selectedModel.modelId } : undefined)).selected;
  const instructions = [
    agentsInTheCloudSystemPrompt,
    codemodeTemplatesInstructions,
    durableJournalInstructions(workspaceId, agentId),
    ...appended,
    ...agents.map(formatProjectInstructions),
    formatSkillsForPrompt(skills.skills),
    `Current working directory: ${workspaceRoot}`,
  ].filter(Boolean).join("\n\n");
  return {
    cwd: workspaceRoot,
    model: selectedModel,
    thinkingLevel: thinking,
    instructions,
  };
}
