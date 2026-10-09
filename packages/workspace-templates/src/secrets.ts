import { Type } from "typebox";
import { workspaceTemplateSecretAllowsPath, secretPathInjectionDefaultHosts } from "./secret-path-policy.ts";
import { randomUUID } from "node:crypto";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { decryptWorkspaceTemplateValue, encryptWorkspaceTemplateValue } from "./secret-crypto.ts";
import { findWorkspaceTemplateRecord, workspaceTemplateSecretSummary, workspaceTemplateSecretSummaries, workspaceTemplatesFile, readWorkspaceTemplateStore, updateWorkspaceTemplateStore, type WorkspaceTemplateRecord, type WorkspaceTemplateSecretSummary, type StoredWorkspaceTemplateSecret } from "./workspace-template.ts";

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

function findWorkspaceTemplateSecret(workspaceTemplate: WorkspaceTemplateRecord, secretId: string): StoredWorkspaceTemplateSecret {
  const secret = workspaceTemplate.secrets?.find((candidate) => candidate.id === secretId);
  if (!secret) throw new AgentsInTheCloudCoreError("workspace_template_secret_not_found", `template secret not found: ${secretId}`);
  return secret;
}

function assertEnvNameAvailable(workspaceTemplate: WorkspaceTemplateRecord, envName: string, exceptSecretId?: string): void {
  if (workspaceTemplate.secrets?.some((secret) => secret.id !== exceptSecretId && secret.envName === envName)) throw new AgentsInTheCloudCoreError("workspace_template_secret_exists", "template secret already exists");
}

export async function listWorkspaceTemplateSecrets(workspaceTemplateId: string, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateSecretSummary[]> {
  const workspaceTemplate = findWorkspaceTemplateRecord(await readWorkspaceTemplateStore(file), workspaceTemplateId);
  return workspaceTemplateSecretSummaries(workspaceTemplate);
}

export async function createWorkspaceTemplateSecret(workspaceTemplateId: string, values: WorkspaceTemplateSecretInput, file = workspaceTemplatesFile(), keyFile?: string): Promise<WorkspaceTemplateSecretSummary> {
  const envName = normalizeEnvName(values.envName);
  const hostPattern = normalizeHostPattern(values.hostPattern);
  const placeholder = normalizePlaceholder(values.placeholder);
  const secretValue = values.secretValue;
  return await updateWorkspaceTemplateStore(file, async (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, workspaceTemplateId);
    workspaceTemplate.secrets ??= [];
    assertEnvNameAvailable(workspaceTemplate, envName);
    const now = new Date().toISOString();
    const id = randomUUID();
    const stored: StoredWorkspaceTemplateSecret = { id, projectId: workspaceTemplateId, envName, hostPattern, placeholder, allowInPath: workspaceTemplateSecretAllowsPath(values), annotation: values.annotation?.trim() ?? "", encryptedSecret: secretValue ? await encryptWorkspaceTemplateValue(workspaceTemplateId, id, secretValue, keyFile) : undefined, createdAt: now, updatedAt: now };
    workspaceTemplate.secrets.push(stored);
    return workspaceTemplateSecretSummary(stored);
  });
}

export async function updateWorkspaceTemplateSecret(workspaceTemplateId: string, secretId: string, values: WorkspaceTemplateSecretInput, file = workspaceTemplatesFile(), keyFile?: string): Promise<WorkspaceTemplateSecretSummary> {
  const envName = normalizeEnvName(values.envName);
  const hostPattern = normalizeHostPattern(values.hostPattern);
  return await updateWorkspaceTemplateStore(file, async (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, workspaceTemplateId);
    const secret = findWorkspaceTemplateSecret(workspaceTemplate, secretId);
    // Changing where an existing value can be sent requires possession of that value.
    const nextPathPermission = values.allowInPath ?? workspaceTemplateSecretAllowsPath(secret);
    const routingChanged = envName !== secret.envName || hostPattern !== secret.hostPattern || nextPathPermission !== workspaceTemplateSecretAllowsPath(secret) || (values.placeholder !== undefined && normalizePlaceholder(values.placeholder) !== secret.placeholder);
    if (secret.encryptedSecret && routingChanged && !values.secretValue) throw new AgentsInTheCloudCoreError("workspace_template_secret_routing_changed", "Re-enter the secret value when changing its name, placeholder, host or path policy");
    assertEnvNameAvailable(workspaceTemplate, envName, secretId);
    secret.envName = envName;
    secret.hostPattern = hostPattern;
    if (values.placeholder !== undefined) {
      const placeholder = normalizePlaceholder(values.placeholder);
      if (placeholder) secret.placeholder = placeholder;
      else delete secret.placeholder;
    }
    if (values.allowInPath !== undefined) secret.allowInPath = values.allowInPath;
    if (values.annotation !== undefined) secret.annotation = values.annotation.trim();
    if (values.secretValue) secret.encryptedSecret = await encryptWorkspaceTemplateValue(workspaceTemplateId, secretId, values.secretValue, keyFile);
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

export async function deleteWorkspaceTemplateSecret(workspaceTemplateId: string, secretId: string, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateSecretSummary> {
  return await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, workspaceTemplateId);
    const secret = findWorkspaceTemplateSecret(workspaceTemplate, secretId);
    workspaceTemplate.secrets = workspaceTemplate.secrets!.filter((candidate) => candidate !== secret);
    return workspaceTemplateSecretSummary(secret);
  });
}

export async function revealWorkspaceTemplateSecrets(workspaceTemplateId: string, file = workspaceTemplatesFile(), keyFile?: string): Promise<WorkspaceTemplateSecretPlaintext[]> {
  const workspaceTemplate = findWorkspaceTemplateRecord(await readWorkspaceTemplateStore(file), workspaceTemplateId);
  return await Promise.all((workspaceTemplate.secrets ?? []).filter((secret) => secret.encryptedSecret).map(async (secret) => {
    const summary = workspaceTemplateSecretSummary(secret);
    return { ...summary, secretValue: await decryptWorkspaceTemplateValue(summary.workspaceTemplateId, secret.id, secret.encryptedSecret!, keyFile) };
  }));
}
