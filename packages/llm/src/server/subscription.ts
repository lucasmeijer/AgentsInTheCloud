import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function usesProviderSubscription(runtime: Pick<ModelRuntime, "listCredentials">, provider: string): Promise<boolean> {
  return (await runtime.listCredentials()).some((credential) => credential.providerId === provider && credential.type === "oauth");
}

export async function requireProviderSubscription(runtime: Pick<ModelRuntime, "listCredentials">, provider: string, agentLabel: string): Promise<void> {
  if (!await usesProviderSubscription(runtime, provider)) {
    throw new AgentsInTheCloudCoreError("agent_setup_required", `Connect a ${agentLabel} subscription before creating a ${agentLabel} agent.`, { setupUrl: `/models?connect=${provider}` });
  }
}
