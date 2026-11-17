import { availableProviderModels } from "./known-model-provider-incorrectness.ts";
import { ModelsError } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderConnection } from "./provider-connections.ts";
import type { ModelRef } from "./model-reference.ts";

interface ProviderAvailability {
  modelIds: ReadonlySet<string>;
  connection: ProviderConnection;
}

export async function providerAvailability(runtime: Pick<ModelRuntime, "getAvailable" | "checkAuth">, providers: readonly string[]) {
  return new Map<string, ProviderAvailability>(await Promise.all([...new Set(providers)].map(async (provider) => {
    try {
      const models = await availableProviderModels(runtime, provider);
      const connection = await runtime.checkAuth(provider) ? "connected" : "disconnected";
      return [provider, { modelIds: new Set(models.map((model) => model.id)), connection }] as const;
    } catch (error) {
      if (!(error instanceof ModelsError) || error.code !== "oauth") throw error;
      return [provider, { modelIds: new Set<string>(), connection: "needs_attention" }] as const;
    }
  })));
}

export function modelUnavailableReason(availability: ProviderAvailability, model: ModelRef, runtime: Pick<ModelRuntime, "getModel">): string | undefined {
  if (availability.modelIds.has(model.id)) return undefined;
  return availability.connection === "needs_attention" ? "Sign in again in Models"
    : availability.connection === "disconnected" ? "Model provider not connected"
    : runtime.getModel(model.provider, model.id) ? "Not available on your account"
    : "No longer in the provider’s catalogue";
}
