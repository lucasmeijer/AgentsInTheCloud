import { clearGitHubToken as clearStoredGitHubToken, discoverGitHubToken, hasGitHubToken as hasStoredGitHubToken, setGitHubToken as setStoredGitHubToken } from "@agents-in-the-cloud/core";
import { workspaceTemplateIdOfInit, revealEffectiveSecrets, onWorkspaceTemplateStoreChanged, workspaceTemplateSecretPlaceholder, workspaceTemplateSecretHosts, workspaceTemplateSecretAllowsPath } from "@agents-in-the-cloud/workspace-templates";
import { getWorkspaceInit, type WorkspaceInitInstruction } from "@agents-in-the-cloud/workspace";
import { matchHostname } from "./patterns.ts";
import { isWorkspaceEgressAddress } from "@agents-in-the-cloud/shared/egress-policy";
import { createHttpHooks, type RequestTransformHttpHooks, type SecretRequestTransform, type SecretDefinition } from "./placeholder-hooks.ts";

export const githubTokenEnvVar = "GH_TOKEN";

export type WorkspaceSecretContext = {
  workspaceId: string;
  env: Record<string, string>;
  hooks: RequestTransformHttpHooks;
  secrets: Array<{ name: string; placeholder: string; hosts: string[] }>;
};

const subscriptionSecrets: Record<string, SecretDefinition> = {};
const requestTransforms = new Map<string, { transform: SecretRequestTransform; hosts: () => Promise<string[]> }>();
const responseTransforms = new Map<string, (response: Response, request: Request) => Promise<Response>>();

/** Host-owned bridges run before ordinary substitution and must register every injected secret for response scrubbing. */
export function registerWorkspaceRequestTransform(id: string, transform: SecretRequestTransform, hosts: () => Promise<string[]> = async () => []): void {
  requestTransforms.set(id, { transform, hosts });
  invalidateContexts();
}

/** HTTPS must be decrypted before host-owned request bridges can see placeholders. */
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
// New requests reload hooks; existing raw CONNECT tunnels still require client reconnection.
function invalidateContexts(): void {
  configurationGeneration++;
  contexts.clear();
}
onWorkspaceTemplateStoreChanged(invalidateContexts);

export { discoverGitHubToken };

export function hasGitHubToken(): boolean {
  return hasStoredGitHubToken();
}

export function setGitHubToken(token: string): void {
  setStoredGitHubToken(token);
  invalidateContexts();
}

export function clearGitHubToken(): void {
  clearStoredGitHubToken();
  invalidateContexts();
}

export async function createWorkspaceSecretContext(workspaceId: string, init?: WorkspaceInitInstruction): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;

  const generation = configurationGeneration;
  const token = discoverGitHubToken();
  const secrets: Record<string, SecretDefinition> = token
    ? { [githubTokenEnvVar]: { value: token, hosts: githubAllowedHosts(), placeholder: workspaceTemplateSecretPlaceholder(githubTokenEnvVar) } }
    : {};
  for (const secret of await revealEffectiveSecrets(workspaceTemplateIdOfInit(init))) {
    secrets[secret.envName] = { value: secret.secretValue, allowInPath: workspaceTemplateSecretAllowsPath(secret), hosts: workspaceTemplateSecretHosts(secret.hostPattern), placeholder: secret.placeholder ?? workspaceTemplateSecretPlaceholder(secret.envName) };
  }
  if (generation !== configurationGeneration) return createWorkspaceSecretContext(workspaceId, init);
  const created = buildContext(workspaceId, { ...secrets, ...subscriptionSecrets });
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

function buildContext(workspaceId: string, secrets: Record<string, SecretDefinition>): WorkspaceSecretContext {
  const hooks = createHttpHooks({
    allowedHosts: ["*"],
    blockInternalRanges: false,
    isIpAllowed: ({ ip }) => isWorkspaceEgressAddress(ip),
    replaceSecretsInQuery: false,
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
    env: Object.fromEntries(Object.entries(hooks.env).filter(([name]) => !(name in subscriptionSecrets))),
    hooks: hooks.httpHooks,
    secrets: hooks.secrets,
  };
}

function githubAllowedHosts(): string[] {
  return ["github.com", "api.github.com"];
}
