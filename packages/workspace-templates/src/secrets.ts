import { Type } from "typebox";
import { workspaceTemplateSecretAllowsPath, secretPathInjectionDefaultHosts } from "./secret-path-policy.ts";
import { randomUUID } from "node:crypto";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { decryptWorkspaceTemplateValue, encryptWorkspaceTemplateValue } from "./secret-crypto.ts";
import { configurationScopeKey, findConfigurationRecord, workspaceScopes, workspaceTemplateSecretSummary, workspaceTemplatesFile, readWorkspaceTemplateStore, updateWorkspaceTemplateStore, type ConfigurationRecord, type ConfigurationScope, type WorkspaceTemplateSecretSummary, type StoredWorkspaceTemplateSecret } from "./workspace-template.ts";

export interface WorkspaceTemplateSecretPlaintext extends WorkspaceTemplateSecretSummary {
  secretValue: string;
}

export interface WorkspaceTemplateSecretInput {
  envName: string;
  hostPattern: string;
  placeholder?: string;
  allowInPath?: boolean;
  annotation?: string;
  secretValue?: string;
}

function normalizeEnvName(value: string): string {
  const envName = value.trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) throw new AgentsInTheCloudCoreError("invalid_arguments", "ENV must be an uppercase environment variable name");
  return envName;
}

function normalizeHostPattern(value: string): string {
  const hostPattern = value.trim().toLowerCase();
  if (!hostPattern) throw new AgentsInTheCloudCoreError("invalid_arguments", "HOST is required");
  return hostPattern;
}

function normalizePlaceholder(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function findWorkspaceTemplateSecret(configuration: ConfigurationRecord, secretId: string): StoredWorkspaceTemplateSecret {
  const secret = configuration.secrets?.find((candidate) => candidate.id === secretId);
  if (!secret) throw new AgentsInTheCloudCoreError("workspace_template_secret_not_found", `template secret not found: ${secretId}`);
  return secret;
}

function assertEnvNameAvailable(configuration: ConfigurationRecord, envName: string, exceptSecretId?: string): void {
  if (configuration.secrets?.some((secret) => secret.id !== exceptSecretId && secret.envName === envName)) throw new AgentsInTheCloudCoreError("workspace_template_secret_exists", `A secret named ${envName} already exists here`);
}

export async function createWorkspaceTemplateSecret(scope: ConfigurationScope, values: WorkspaceTemplateSecretInput, file = workspaceTemplatesFile(), keyFile?: string): Promise<WorkspaceTemplateSecretSummary> {
  const envName = normalizeEnvName(values.envName);
  const hostPattern = normalizeHostPattern(values.hostPattern);
  const placeholder = normalizePlaceholder(values.placeholder);
  const secretValue = values.secretValue;
  return await updateWorkspaceTemplateStore(file, async (store) => {
    const configuration = findConfigurationRecord(store, scope);
    configuration.secrets ??= [];
    assertEnvNameAvailable(configuration, envName);
    const now = new Date().toISOString();
    const id = randomUUID();
    const stored: StoredWorkspaceTemplateSecret = { id, projectId: configurationScopeKey(scope), envName, hostPattern, placeholder, allowInPath: workspaceTemplateSecretAllowsPath(values), annotation: values.annotation?.trim() ?? "", encryptedSecret: secretValue ? await encryptWorkspaceTemplateValue(configurationScopeKey(scope), id, secretValue, keyFile) : undefined, createdAt: now, updatedAt: now };
    configuration.secrets.push(stored);
    return workspaceTemplateSecretSummary(stored);
  });
}

export async function updateWorkspaceTemplateSecret(scope: ConfigurationScope, secretId: string, values: WorkspaceTemplateSecretInput, file = workspaceTemplatesFile(), keyFile?: string): Promise<WorkspaceTemplateSecretSummary> {
  const envName = normalizeEnvName(values.envName);
  const hostPattern = normalizeHostPattern(values.hostPattern);
  return await updateWorkspaceTemplateStore(file, async (store) => {
    const configuration = findConfigurationRecord(store, scope);
    const secret = findWorkspaceTemplateSecret(configuration, secretId);
    assertEnvNameAvailable(configuration, envName, secretId);
    secret.envName = envName;
    secret.hostPattern = hostPattern;
    if (values.placeholder !== undefined) {
      const placeholder = normalizePlaceholder(values.placeholder);
      if (placeholder) secret.placeholder = placeholder;
      else delete secret.placeholder;
    }
    if (values.allowInPath !== undefined) secret.allowInPath = values.allowInPath;
    if (values.annotation !== undefined) secret.annotation = values.annotation.trim();
    if (values.secretValue) secret.encryptedSecret = await encryptWorkspaceTemplateValue(configurationScopeKey(scope), secretId, values.secretValue, keyFile);
    secret.updatedAt = new Date().toISOString();
    return workspaceTemplateSecretSummary(secret);
  });
}

export function workspaceTemplateSecretPlaceholder(name: string): string {
  return `AGENTSINTHECLOUD_PROXY_READY_${name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
}

export const workspaceTemplateSecretPathPermissionSchema = Type.Boolean({
  description: `Allow secret substitution in URL paths. Defaults to true only when all hosts are exact matches in: ${secretPathInjectionDefaultHosts.join(", ")}. Otherwise false. Omit on updates to keep the saved permission.`,
});

export async function deleteWorkspaceTemplateSecret(scope: ConfigurationScope, secretId: string, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateSecretSummary> {
  return await updateWorkspaceTemplateStore(file, (store) => {
    const configuration = findConfigurationRecord(store, scope);
    const secret = findWorkspaceTemplateSecret(configuration, secretId);
    configuration.secrets = configuration.secrets!.filter((candidate) => candidate !== secret);
    return workspaceTemplateSecretSummary(secret);
  });
}

export async function revealWorkspaceTemplateSecrets(scope: ConfigurationScope, file = workspaceTemplatesFile(), keyFile?: string): Promise<WorkspaceTemplateSecretPlaintext[]> {
  const configuration = findConfigurationRecord(await readWorkspaceTemplateStore(file), scope);
  return await Promise.all((configuration.secrets ?? []).filter((secret) => secret.encryptedSecret).map(async (secret) => (
    { ...workspaceTemplateSecretSummary(secret), secretValue: await decryptWorkspaceTemplateValue(secret.projectId, secret.id, secret.encryptedSecret!, keyFile) }
  )));
}

/** Global secrets and the template's own, which replace global ones with the same name. */
export async function revealEffectiveSecrets(workspaceTemplateId?: string, file = workspaceTemplatesFile(), keyFile?: string): Promise<WorkspaceTemplateSecretPlaintext[]> {
  const secrets = (await Promise.all(workspaceScopes(workspaceTemplateId).map((scope) => revealWorkspaceTemplateSecrets(scope, file, keyFile)))).flat();
  return [...new Map(secrets.map((secret) => [secret.envName, secret])).values()];
}
