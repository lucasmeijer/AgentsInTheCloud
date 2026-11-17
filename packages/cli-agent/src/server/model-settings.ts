import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments, type JsonObject } from "@agents-in-the-cloud/core";
import { getAgentModelPreference, setAgentModelPreference, getAgentModelThinkingLevel, createPiModelRuntime, modelUnavailableReason, providerAvailability, getEnabledModels, hasConnectedModelProvider, modelRefValue, modelThinkingLevels, renderLaunchModelSettings, renderReadOnlyLaunchModelSettings, type ComposerModelOption, type ModelRef } from "@agents-in-the-cloud/llm/server";
import type { AgentLaunchFooterContext } from "@agents-in-the-cloud/shared";

const settingsSchema = Type.Object({ model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()) });

export interface CliModelSettings { model?: string; thinkingLevel?: string }

export function createCliModelSettings(options: {
  agentTypeId: string; label: string;
  provider?: string;
  unavailableReason?(runtime: Awaited<ReturnType<typeof createPiModelRuntime>>, model: ModelRef): Promise<string | undefined>;
  mapThinkingLevel(level: string, mapped: string | null | undefined): string | undefined;
}) {
  async function choices(requestedModel?: string, requestedLevel?: string) {
    const remembered = await getAgentModelPreference(options.agentTypeId);
    const runtime = await createPiModelRuntime();
    const enabledModels = (await getEnabledModels()).filter((model) => !options.provider || model.provider === options.provider);
    const availability = await providerAvailability(runtime, enabledModels.map((model) => model.provider));
    const models: ComposerModelOption[] = await Promise.all(enabledModels.map(async (model) => {
      const unavailableReason = modelUnavailableReason(availability.get(model.provider)!, model, runtime)
        ?? await options.unavailableReason?.(runtime, model);
      return { ...model, name: model.label, selected: false, available: !unavailableReason, unavailableReason };
    }));
    const preferredModel = requestedModel || (remembered ? modelRefValue(remembered) : undefined);
    const selected = models.find((model) => model.available && modelRefValue(model) === preferredModel)
      ?? models.find((model) => model.available);
    if (selected) selected.selected = true;
    const selectedValue = selected ? modelRefValue(selected) : "";
    const selectedModel = selected ? runtime.getModel(selected.provider, selected.id) : undefined;
    const thinkingLevels = selected && selectedModel ? [...new Set((await modelThinkingLevels(selected)).flatMap((level) => {
      const mapped = selectedModel.thinkingLevelMap?.[level];
      const thinkingLevel = options.mapThinkingLevel(level, mapped);
      return thinkingLevel === undefined ? [] : [thinkingLevel];
    }))] : [];
    const preferredLevel = requestedLevel || (selected ? await getAgentModelThinkingLevel(options.agentTypeId, selected) : undefined);
    const selectedThinkingLevel = preferredLevel && thinkingLevels.includes(preferredLevel) ? preferredLevel
      : thinkingLevels.includes("medium") ? "medium" : thinkingLevels[0] ?? "";
    return { models, selected, selectedValue, thinkingLevels, selectedThinkingLevel, connectedProvider: options.provider ? runtime.getProviderAuthStatus(options.provider).configured : hasConnectedModelProvider(runtime) };
  }

  async function renderFooter(context: AgentLaunchFooterContext): Promise<string> {
    if (context.readOnly) return renderReadOnlyLaunchModelSettings(context.query.get("model") ?? undefined, context.query.get("thinkingLevel") ?? undefined);
    return renderLaunchModelSettings({ ...context, agentTypeId: options.agentTypeId, ...await choices(context.query.get("model") ?? undefined, context.query.get("thinkingLevel") ?? undefined) });
  }

  async function prepare(parameters: JsonObject = {}): Promise<CliModelSettings> {
    const settings = { model: parameters.model, thinkingLevel: parameters.thinkingLevel };
    if (!Value.Check(settingsSchema, settings)) throw invalidArguments(`${options.label} model and thinkingLevel must be strings`);
    const { model, thinkingLevel: level } = settings;
    const selection = await choices(model, level);
    if (model && !selection.models.some((item) => modelRefValue(item) === model && item.available)) throw invalidArguments(`Choose an available enabled ${options.label} model`);
    if (level && !selection.thinkingLevels.includes(level)) throw invalidArguments(`Unsupported ${options.label} thinking level`);
    if (selection.selected) {
      await setAgentModelPreference(options.agentTypeId, { provider: selection.selected.provider, id: selection.selected.id }, selection.selectedThinkingLevel);
    }
    return { model: selection.selectedValue || undefined, thinkingLevel: selection.selectedThinkingLevel || undefined };
  }

  return { renderFooter, prepare };
}
