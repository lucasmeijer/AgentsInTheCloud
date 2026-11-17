import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { connectModelProviderApiKey, getCustomModelsJson, setCustomModelsJson, validateModelProviderApiKey } from "./pi-config-models.ts";

export const customOpenAIProtocols = [
  { id: "openai-completions", name: "Custom OpenAI Chat Completions endpoint" },
  { id: "openai-responses", name: "Custom OpenAI Responses endpoint" },
] as const;
export type CustomOpenAIProtocol = typeof customOpenAIProtocols[number]["id"];
export const customOpenAIDefaults = { contextWindow: 32768, maxTokens: 4096 };

export interface CustomOpenAIEndpointInput {
  api: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId?: string;
  contextWindow: number;
  maxTokens: number;
}

export class CustomEndpointInputError extends Error {}

function endpointSettings(input: CustomOpenAIEndpointInput) {
  const api = customOpenAIProtocols.find(protocol => protocol.id === input.api)?.id;
  if (!api) throw new CustomEndpointInputError("Choose Chat Completions or Responses.");
  const name = input.name.trim();
  if (!name) throw new CustomEndpointInputError("Give this endpoint a name.");
  let url: URL;
  try { url = new URL(input.baseUrl.trim()); }
  catch { throw new CustomEndpointInputError("Enter a complete HTTP or HTTPS base URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CustomEndpointInputError("Use an HTTP or HTTPS base URL without embedded credentials, a query, or a fragment.");
  }
  if (!Number.isSafeInteger(input.contextWindow) || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.contextWindow < 1 || input.maxTokens > input.contextWindow) {
    throw new CustomEndpointInputError("Token limits must be positive whole numbers, with output tokens no larger than the context window.");
  }
  return { name, baseUrl: url.href.replace(/\/$/, ""), api };
}

const modelListSchema = Type.Object({ data: Type.Array(Type.Object({ id: Type.String({ pattern: "\\S" }) })) });

async function discoverModels(baseUrl: string, apiKey: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new CustomEndpointInputError("Couldn't reach the model list. Check the base URL and network access, or enter a model ID manually."); }
  if (!response.ok) throw new CustomEndpointInputError(`Model listing returned HTTP ${response.status}. Check the URL and key, or enter a model ID manually.`);
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new CustomEndpointInputError("The model list wasn't valid JSON. Enter a model ID manually."); }
  if (!Value.Check(modelListSchema, body)) throw new CustomEndpointInputError("Expected an OpenAI model list with data[].id. Enter a model ID manually.");
  if (body.data.some(model => model.id.includes(apiKey))) throw new CustomEndpointInputError("The endpoint returned credentials in its model list. No models were saved.");
  if (!body.data.length) throw new CustomEndpointInputError("The endpoint returned no models. Load a model on the server, or enter its ID manually.");
  return body.data.map(model => model.id.trim());
}

export async function connectCustomOpenAIEndpoint(input: CustomOpenAIEndpointInput, discover: boolean): Promise<string> {
  const settings = endpointSettings(input);
  const key = input.apiKey.trim() || "local-no-auth";
  const modelId = input.modelId?.trim();
  if (!discover && !modelId) throw new CustomEndpointInputError("Enter a model ID or fetch models from the endpoint.");
  const ids = discover ? await discoverModels(settings.baseUrl, key) : [modelId!];
  const provider = `custom-openai-${crypto.randomUUID()}`;
  const models = [...new Set(ids)].map(id => ({
    id, name: id, reasoning: false, input: ["text"] satisfies Model<CustomOpenAIProtocol>["input"],
    contextWindow: input.contextWindow, maxTokens: input.maxTokens,
  }));
  if (!discover) {
    const model: Model<CustomOpenAIProtocol> = { ...models[0]!, provider, api: settings.api, baseUrl: settings.baseUrl, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    try { await validateModelProviderApiKey(provider, key, model); }
    catch { throw new CustomEndpointInputError("The model request failed. Check the URL, key, model ID and selected protocol."); }
  }
  const stored = await getCustomModelsJson();
  const configuration = stored ? JSON.parse(stored) : { providers: {} };
  configuration.providers[provider] = { ...settings, models };
  await setCustomModelsJson(JSON.stringify(configuration));
  await connectModelProviderApiKey(provider, key, { validate: false });
  return provider;
}
