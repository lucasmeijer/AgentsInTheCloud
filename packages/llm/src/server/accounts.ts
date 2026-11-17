import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getPopularProviderRank } from "./hardcoded-provider-knowledge.ts";
import { providerAccountSummary } from "./provider-accounts.ts";
import { providerConnections, type ProviderConnection } from "./provider-connections.ts";
import { usesProviderSubscription } from "./subscription.ts";

type AccountRuntime = Pick<ModelRuntime, "getProviders" | "getProviderAuthStatus" | "listCredentials" | "getAuth">;

export interface Account {
  id: string;
  provider: string;
  label: string;
  method: "subscription" | "api_key" | "environment";
  description?: string;
  connection: Exclude<ProviderConnection, "disconnected">;
}

export function providerLabel(provider: { id: string; name?: string }): string {
  return provider.id === "openai-codex" ? "ChatGPT / Codex" : provider.id === "openai" ? "OpenAI - Sign in with ChatGPT" : provider.name ?? provider.id;
}

export function sortByPopularity<T extends { provider: string; label: string }>(items: T[]): T[] {
  const rank = (provider: string) => getPopularProviderRank(provider) ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => rank(a.provider) - rank(b.provider) || a.label.localeCompare(b.label));
}

export async function listAccounts(runtime: AccountRuntime): Promise<Account[]> {
  const connections = await providerConnections(runtime);
  const accounts = await Promise.all(runtime.getProviders().map(async (provider): Promise<Account | undefined> => {
    const connection = connections.get(provider.id)!;
    if (connection === "disconnected") return undefined;
    const method = runtime.getProviderAuthStatus(provider.id).source !== "stored" ? "environment"
      : await usesProviderSubscription(runtime, provider.id) ? "subscription" : "api_key";
    return {
      id: provider.id,
      provider: provider.id,
      label: providerLabel(provider),
      method,
      description: connection === "connected" ? await providerAccountSummary(runtime, provider.id) : undefined,
      connection,
    };
  }));
  return sortByPopularity(accounts.filter((account) => account !== undefined));
}
