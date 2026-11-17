import { hasAvailableBuiltinAgentModel } from "./model-state.ts";
import { reconcileAgentModelPreferences } from "@agents-in-the-cloud/agent/server/model-preferences";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments, type JsonObject } from "@agents-in-the-cloud/core";
import { renderReadOnlyLaunchModelSettings, renderModelsDialog, parseModelRef, setAgentModelPreference } from "@agents-in-the-cloud/llm/server";
import { turboStream, turboStreamResponse, type AgentWorkspaceParameters, type WorkspaceAgentLaunch } from "@agents-in-the-cloud/shared";
import { listStagedAttachments } from "@agents-in-the-cloud/prompt/server";
import { catalogueModelUnavailableReason } from "@agents-in-the-cloud/agent/server/model-state";
import { renderLaunchComposerSettings } from "./render-composer.ts";
import { ensureDefaultWorkspaceAgent } from "./agent-store.ts";
import { refreshConfiguredAgentRuntimes } from "./runtime.ts";

const stringSchema = Type.String();

function stringParameter(parameters: JsonObject, name: string): string {
  const value = parameters[name];
  if (value === undefined || value === null) return "";
  if (!Value.Check(stringSchema, value)) throw invalidArguments(`agent.${name} must be a string`);
  return value.trim();
}

async function requireRunnableModel(value: string): Promise<void> {
  const requested = parseModelRef(value);
  if (!requested) throw invalidArguments("agent.model must look like provider::model");
  const reason = await catalogueModelUnavailableReason(requested);
  if (reason) throw invalidArguments(`${value} can't run: ${reason}`);
}

export async function prepareAgentLaunch(parameters: JsonObject = {}): Promise<{ agent: AgentWorkspaceParameters } | undefined> {
  const initialPromptMode = stringParameter(parameters, "initialPromptMode");
  if (initialPromptMode && initialPromptMode !== "composer") throw invalidArguments("agent.initialPromptMode must be composer");
  const agent: AgentWorkspaceParameters = {
    initialPrompt: stringParameter(parameters, "initialPrompt"),
    model: stringParameter(parameters, "model"),
    thinkingLevel: stringParameter(parameters, "thinkingLevel"),
    attachmentDraft: stringParameter(parameters, "attachmentDraft"),
  };
  if (initialPromptMode) agent.initialPromptMode = "composer";
  if (!Object.values(agent).some(Boolean)) return undefined;
  if (!agent.initialPromptMode && (agent.initialPrompt || agent.attachmentDraft)) {
    if (agent.model) await requireRunnableModel(agent.model);
    else if (!await hasAvailableBuiltinAgentModel()) {
      agent.initialPromptMode = "composer";
      agent.thinkingLevel = "";
    }
  }
  return { agent };
}

export const nativeAgentLaunch: WorkspaceAgentLaunch = {
  renderFooter({ query, ...context }) {
    if (context.readOnly) return renderReadOnlyLaunchModelSettings(query.get("model") ?? undefined, query.get("thinkingLevel") ?? undefined);
    return renderLaunchComposerSettings({ ...context, selectedModel: query.get("model") ?? undefined, selectedThinkingLevel: query.get("thinkingLevel") ?? undefined });
  },
  prepare: prepareAgentLaunch,
  async submit(form) {
    const hasPrompt = String(form.get("text") ?? "").trim().length > 0
      || (await listStagedAttachments(String(form.get("attachmentDraft") ?? ""))).length > 0;
    if (hasPrompt && !await hasAvailableBuiltinAgentModel()) return { response: turboStreamResponse(turboStream("update", "settings_modal_host", await renderModelsDialog({ focus: "models" })), { status: 422 }) };
    const model = String(form.get("model") ?? "");
    const thinkingLevel = String(form.get("thinkingLevel") ?? "");
    return {
      async prepare() {
        const ref = parseModelRef(model);
        if (ref) await setAgentModelPreference("builtin", ref, thinkingLevel);
        const context = await prepareAgentLaunch({ model, thinkingLevel });
        return context ?? { agent: {} };
      },
    };
  },
  async prepareWorkspace(workspaceId) {
    await ensureDefaultWorkspaceAgent(workspaceId);
  },
  async refreshConfiguration(frameId) {
    await reconcileAgentModelPreferences();
    await refreshConfiguredAgentRuntimes();
    return turboStream("append", frameId, '<span hidden data-controller="launch-model-refresh"></span>');
  },
};
