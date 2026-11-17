import { ModelsError } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { usesProviderSubscription } from "./subscription.ts";

export type ProviderConnection = "connected" | "disconnected" | "needs_attention";

export async function providerConnections(runtime: Pick<ModelRuntime, "getProviderAuthStatus" | "listCredentials" | "getAuth"> & { getProviders(): readonly { id: string }[] }): Promise<Map<string, ProviderConnection>> {
  return new Map(await Promise.all(runtime.getProviders().map(async (provider) => {
    const status = runtime.getProviderAuthStatus(provider.id);
    if (!status.configured || status.source !== "stored" || !await usesProviderSubscription(runtime, provider.id)) {
      return [provider.id, status.configured ? "connected" : "disconnected"] as const;
    }
    try {
      // Pi serializes refresh and persists rotated tokens. Do not expire a
      // connection just because its short-lived access token needs refreshing.
      const auth = await runtime.getAuth(provider.id, { signal: AbortSignal.timeout(10_000) });
      return [provider.id, auth ? "connected" : "disconnected"] as const;
    } catch (error) {
      if (!(error instanceof ModelsError) || error.code !== "oauth") throw error;
      return [provider.id, "needs_attention"] as const;
    }
  })));
}
