import { connectedGitHostingProviders, onGitHostingCredentialsChanged } from "@agents-in-the-cloud/git-hosting";
import { workspaceTemplateIdOfInit, revealEffectiveSecrets, effectivePrivateNetworkAccess, onWorkspaceTemplateStoreChanged, workspaceTemplateSecretPlaceholder, workspaceTemplateSecretHosts, workspaceTemplateSecretAllowsPath, requestedPrivateNetworkDestination, type PrivateNetworkDestination } from "@agents-in-the-cloud/workspace-templates";
import { getWorkspaceInit, type WorkspaceInitInstruction } from "@agents-in-the-cloud/workspace";
import { matchHostname } from "./patterns.ts";
import { isPrivateNetworkAddress, isWorkspaceEgressAddress } from "@agents-in-the-cloud/shared/egress-policy";
import { createHttpHooks, type RequestTransformHttpHooks, type SecretRequestTransform, type SecretDefinition } from "./placeholder-hooks.ts";

export type WorkspaceSecretContext = {
  workspaceId: string;
  env: Record<string, string>;
  hooks: RequestTransformHttpHooks;
  secrets: Array<{ name: string; placeholder: string; hosts: string[] }>;
};

const subscriptionSecrets: Record<string, SecretDefinition> = {};
const requestTransforms = new Map<string, { transform: SecretRequestTransform; hosts: () => Promise<string[]> }>();
const responseTransforms = new Map<string, (response: Response, request: Request) => Promise<Response>>();

export function registerWorkspaceRequestTransform(id: string, transform: SecretRequestTransform, hosts: () => Promise<string[]> = async () => []): void {
  requestTransforms.set(id, { transform, hosts });
  invalidateContexts();
}

export async function workspaceRequestTransformMatchesHost(hostname: string): Promise<boolean> {
  for (const { hosts } of requestTransforms.values()) {
    if ((await hosts()).some((host) => matchHostname(hostname, host))) return true;
  }
  return false;
}

export function registerWorkspaceResponseTransform(id: string, transform: (response: Response, request: Request) => Promise<Response>): void {
  responseTransforms.set(id, transform);
  invalidateContexts();
}

export function registerWorkspaceSubscriptionSecrets(secrets: Record<string, SecretDefinition>): void {
  Object.assign(subscriptionSecrets, secrets);
  invalidateContexts();
}

const contexts = new Map<string, WorkspaceSecretContext>();
let configurationGeneration = 0;
function invalidateContexts(): void {
  configurationGeneration++;
  contexts.clear();
}
onWorkspaceTemplateStoreChanged(invalidateContexts);
onGitHostingCredentialsChanged(invalidateContexts);

export async function createWorkspaceSecretContext(workspaceId: string, init?: WorkspaceInitInstruction): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;

  const generation = configurationGeneration;
  const secrets: Record<string, SecretDefinition> = {};
  const plainEnv: Record<string, string> = {};
  for (const { provider, credential } of connectedGitHostingProviders()) {
    const placeholder = workspaceTemplateSecretPlaceholder(provider.tokenEnvVar);
    secrets[provider.tokenEnvVar] = { value: credential.token, hosts: provider.tokenHosts, placeholder };
    Object.assign(plainEnv, provider.workspaceEnv(credential));
    for (const alias of provider.tokenEnvAliases) plainEnv[alias] = placeholder;
  }
  const workspaceTemplateId = workspaceTemplateIdOfInit(init);
  const privateNetworkAccess = await effectivePrivateNetworkAccess(workspaceTemplateId);
  for (const secret of await revealEffectiveSecrets(workspaceTemplateId)) {
    secrets[secret.envName] = { value: secret.secretValue, allowInPath: workspaceTemplateSecretAllowsPath(secret), hosts: workspaceTemplateSecretHosts(secret.hostPattern), placeholder: secret.placeholder ?? workspaceTemplateSecretPlaceholder(secret.envName) };
  }
  if (generation !== configurationGeneration) return createWorkspaceSecretContext(workspaceId, init);
  const created = buildContext(workspaceId, { ...secrets, ...subscriptionSecrets }, plainEnv, privateNetworkAccess);
  contexts.set(workspaceId, created);
  return created;
}

export async function getWorkspaceSecretContext(
  workspaceId: string,
  loadWorkspaceInit: (workspaceId: string) => Promise<WorkspaceInitInstruction | undefined> = getWorkspaceInit,
): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;
  return await createWorkspaceSecretContext(workspaceId, await loadWorkspaceInit(workspaceId));
}

export function forgetWorkspaceSecretContext(workspaceId: string): void {
  contexts.delete(workspaceId);
}

export function privateNetworkAccessAllows(destinations: readonly PrivateNetworkDestination[], { hostname, ip, port }: { hostname: string; ip: string; port: number }): boolean {
  if (isWorkspaceEgressAddress(ip)) return true;
  const requested = requestedPrivateNetworkDestination(hostname, port);
  return isPrivateNetworkAddress(ip) && destinations.some((destination) => destination.host === requested.host && destination.port === requested.port);
}

function buildContext(workspaceId: string, secrets: Record<string, SecretDefinition>, plainEnv: Record<string, string>, privateNetworkAccess: PrivateNetworkDestination[]): WorkspaceSecretContext {
  const hooks = createHttpHooks({
    allowedHosts: ["*"],
    blockInternalRanges: false,
    isIpAllowed: (info) => privateNetworkAccessAllows(privateNetworkAccess, info),
    secrets,
    onRequest: async (request, registerSecret) => {
      for (const { transform } of requestTransforms.values()) request = await transform(request, registerSecret);
      return request;
    },
    onResponse: async (response, request) => {
      for (const transform of responseTransforms.values()) response = await transform(response, request);
      return response;
    },
  });
  return {
    workspaceId,
    env: { ...plainEnv, ...Object.fromEntries(Object.entries(hooks.env).filter(([name]) => !(name in subscriptionSecrets))) },
    hooks: hooks.httpHooks,
    secrets: hooks.secrets,
  };
}
