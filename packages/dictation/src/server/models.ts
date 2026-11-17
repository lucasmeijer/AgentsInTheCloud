import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import { readJsonSettings, updateJsonSettings } from "@agents-in-the-cloud/core/json-settings";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const dictationModels = [
  {
    id: "nemotron-3.5", name: "Nemotron 3.5", description: "Multilingual streaming dictation",
    artifact: { repository: "nvidia/nemotron-3.5-asr-streaming-0.6b", revision: "1c8deaecc64b91f034d73e08dd8b64625eb3395d", filename: "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf", size: 741548352 },
  },
  {
    id: "nemotron-en", name: "Nemotron English", description: "English streaming dictation",
    artifact: { repository: "nvidia/nemotron-speech-streaming-en-0.6b", revision: "ebe59e5a817142986528bbbee5dba8db7b38ed50", filename: "nemotron-speech-streaming-en-0.6b.q8_0.gguf", size: 699872960 },
  },
] as const;

export type DictationModelId = (typeof dictationModels)[number]["id"];
export const defaultDictationModel: DictationModelId = "nemotron-en";

const settingsSchema = Type.Object({
  model: Type.Optional(Type.Union([
    ...dictationModels.map(({ id }) => Type.Literal(id)),
    Type.Literal("parakeet-tdt"),
    Type.Literal("parakeet-ctc"),
  ])),
});

function settingsPath(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "transcription.json");
}

export function isDictationModelId(value: string): value is DictationModelId {
  return dictationModels.some((model) => model.id === value);
}

export function dictationModel(id: DictationModelId): (typeof dictationModels)[number] {
  const model = dictationModels.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`unsupported dictation model: ${id}`);
  return model;
}

export async function readDictationModel(): Promise<DictationModelId> {
  const { model } = Value.Parse(settingsSchema, await readJsonSettings(settingsPath()));
  return model && isDictationModelId(model) ? model : defaultDictationModel;
}

export async function writeDictationModel(model: DictationModelId): Promise<void> {
  await updateJsonSettings(settingsPath(), (settings) => {
    settings.model = model;
  });
}
