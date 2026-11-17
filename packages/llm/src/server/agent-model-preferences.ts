import { readJsonSettings, updateJsonSettings } from "@agents-in-the-cloud/core/json-settings";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, isJsonObject, type JsonObject, type JsonValue } from "@agents-in-the-cloud/core";
import { modelRefValue, type ModelRef } from "./model-reference.ts";

function settingsPath(): string { return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "pi-config", "models.json"); }
const stringSchema = Type.String();
function object(value: JsonValue | undefined): JsonObject { return isJsonObject(value) ? value : {}; }

function preferences(stored: JsonObject, agentTypeId: string): JsonObject {
  const scoped = object(stored.agentPreferences)[agentTypeId];
  if (isJsonObject(scoped)) return scoped;
  return agentTypeId === "builtin" ? {
    activeModel: stored.activeModel ?? null,
    modelPreferences: stored.modelPreferences ?? {},
  } : {};
}

async function update(agentTypeId: string, change: (preference: JsonObject) => void): Promise<void> {
  await updateJsonSettings(settingsPath(), (stored) => {
    const agents = object(stored.agentPreferences);
    const preference = preferences(stored, agentTypeId);
    change(preference);
    agents[agentTypeId] = preference;
    stored.agentPreferences = agents;
    if (agentTypeId === "builtin") {
      delete stored.activeModel;
      delete stored.modelPreferences;
    }
  });
}

export async function getAgentModelPreference(agentTypeId: string): Promise<ModelRef | undefined> {
  const active = object(preferences(await readJsonSettings(settingsPath()), agentTypeId).activeModel);
  if (!Value.Check(stringSchema, active.provider) || !Value.Check(stringSchema, active.id)) return undefined;
  return active.provider && active.id ? { provider: active.provider, id: active.id } : undefined;
}

function setThinking(preference: JsonObject, model: ModelRef, level: string): void {
  const models = object(preference.modelPreferences);
  const key = modelRefValue(model);
  models[key] = { ...object(models[key]), thinkingLevel: level };
  preference.modelPreferences = models;
}

export async function setAgentModelPreference(agentTypeId: string, model: ModelRef | undefined, thinkingLevel?: string): Promise<void> {
  await update(agentTypeId, (preference) => {
    if (model) preference.activeModel = { ...model };
    else delete preference.activeModel;
    if (model && thinkingLevel) setThinking(preference, model, thinkingLevel);
  });
}

export async function getAgentModelThinkingLevel(agentTypeId: string, model: ModelRef): Promise<string | undefined> {
  const stored = preferences(await readJsonSettings(settingsPath()), agentTypeId);
  const level = object(object(stored.modelPreferences)[modelRefValue(model)]).thinkingLevel;
  return Value.Check(stringSchema, level) ? level || undefined : undefined;
}

export async function setAgentModelThinkingLevel(agentTypeId: string, model: ModelRef, level: string): Promise<void> {
  await update(agentTypeId, (preference) => setThinking(preference, model, level));
}
