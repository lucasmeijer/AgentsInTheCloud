import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentEnabledModels } from "./model-preferences.ts";
import { createPiModelRuntime, modelUnavailableReason, providerAvailability, modelThinkingLevels, getAgentModelThinkingLevel, type ModelRef } from "@agents-in-the-cloud/llm/server";

export interface AgentModelOptionView {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
  available: boolean;
  unavailableReason?: string;
}

export function selectAvailableEnabledModel(models: readonly AgentModelOptionView[], requested?: ModelRef): ModelRef | undefined {
  const selected = requested
    ? models.find((model) => model.available && model.provider === requested.provider && model.id === requested.id)
    : undefined;
  const fallback = selected ?? models.find((model) => model.available && model.selected) ?? models.find((model) => model.available);
  return fallback ? { provider: fallback.provider, id: fallback.id } : undefined;
}

export async function resolveNewWorkspaceAgentModel(): Promise<ModelRef | undefined> {
  return selectAvailableEnabledModel(await enabledModelOptionViews());
}

export async function catalogueModelUnavailableReason(model: ModelRef): Promise<string | undefined> {
  const runtime = await createPiModelRuntime();
  if (!runtime.getModel(model.provider, model.id)) return "Not in the provider’s catalogue";
  return modelUnavailableReason((await providerAvailability(runtime, [model.provider])).get(model.provider)!, model, runtime);
}

export async function enabledModelOptionViews(current?: ModelRef | null, runtime?: Pick<Awaited<ReturnType<typeof createPiModelRuntime>>, "getAvailable" | "checkAuth" | "getModel">): Promise<AgentModelOptionView[]> {
  runtime ??= await createPiModelRuntime();
  const models = await getAgentEnabledModels();
  const availability = await providerAvailability(runtime, models.map((model) => model.provider));
  return models.map((model) => {
    const unavailableReason = modelUnavailableReason(availability.get(model.provider)!, model, runtime);
    return {
      provider: model.provider,
      id: model.id,
      name: model.label,
      selected: current === undefined ? Boolean(model.active) : current !== null && current.provider === model.provider && current.id === model.id,
      available: !unavailableReason,
      unavailableReason,
    };
  });
}

export async function launchComposerThinkingSettings(model: ModelRef | undefined): Promise<{ levels: string[]; selected?: ModelThinkingLevel }> {
  if (!model) return { levels: [] };
  const levels = await modelThinkingLevels(model);
  const remembered = await getAgentModelThinkingLevel("builtin", { provider: model.provider, id: model.id });
  return { levels, selected: levels.find((level) => level === remembered) ?? (levels.includes("medium") ? "medium" : levels[0]) };
}
