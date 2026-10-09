import { randomUUID } from "node:crypto";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { configurationScopeKey, findConfigurationRecord, workspaceScopes, workspaceTemplatesFile, readWorkspaceTemplateStore, updateWorkspaceTemplateStore, type WorkspaceTemplateEnvironmentVariable, type StoredWorkspaceTemplateEnvironmentVariable, workspaceTemplateEnvironmentVariableSummary, type ConfigurationRecord, type ConfigurationScope } from "./workspace-template.ts";

function normalizeName(value: string): string {
  const name = value.trim();
  validateWorkspaceTemplateEnvironmentName(name);
  return name;
}

export function validateWorkspaceTemplateEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AgentsInTheCloudCoreError("invalid_arguments", "NAME must be an environment variable name");
}

function findVariable(configuration: ConfigurationRecord, variableId: string): StoredWorkspaceTemplateEnvironmentVariable {
  const variable = configuration.environment?.find((candidate) => candidate.id === variableId);
  if (!variable) throw new AgentsInTheCloudCoreError("workspace_template_environment_variable_not_found", `template environment variable not found: ${variableId}`);
  return variable;
}

function assertNameAvailable(configuration: ConfigurationRecord, name: string, exceptVariableId?: string): void {
  if (configuration.environment?.some((variable) => variable.id !== exceptVariableId && variable.name === name)) throw new AgentsInTheCloudCoreError("workspace_template_environment_variable_exists", `A variable named ${name} already exists here`);
}

/** Global variables and the template's own, which replace global ones with the same name. */
export async function effectiveEnvironment(workspaceTemplateId?: string, file = workspaceTemplatesFile()): Promise<Record<string, string>> {
  const store = await readWorkspaceTemplateStore(file);
  return Object.fromEntries(workspaceScopes(workspaceTemplateId).flatMap((scope) => findConfigurationRecord(store, scope).environment ?? []).map(({ name, value }) => [name, value]));
}

export async function createWorkspaceTemplateEnvironmentVariable(scope: ConfigurationScope, values: { name: string; value: string }, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateEnvironmentVariable> {
  const name = normalizeName(values.name);
  return await updateWorkspaceTemplateStore(file, (store) => {
    const configuration = findConfigurationRecord(store, scope);
    configuration.environment ??= [];
    assertNameAvailable(configuration, name);
    const now = new Date().toISOString();
    const variable: StoredWorkspaceTemplateEnvironmentVariable = { id: randomUUID(), projectId: configurationScopeKey(scope), name, value: values.value, createdAt: now, updatedAt: now };
    configuration.environment!.push(variable);
    return workspaceTemplateEnvironmentVariableSummary(variable);
  });
}

export async function updateWorkspaceTemplateEnvironmentVariable(scope: ConfigurationScope, variableId: string, values: { name: string; value: string }, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateEnvironmentVariable> {
  const name = normalizeName(values.name);
  return await updateWorkspaceTemplateStore(file, (store) => {
    const configuration = findConfigurationRecord(store, scope);
    const variable = findVariable(configuration, variableId);
    assertNameAvailable(configuration, name, variableId);
    variable.name = name;
    variable.value = values.value;
    variable.updatedAt = new Date().toISOString();
    return workspaceTemplateEnvironmentVariableSummary(variable);
  });
}

export async function deleteWorkspaceTemplateEnvironmentVariable(scope: ConfigurationScope, variableId: string, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateEnvironmentVariable> {
  return await updateWorkspaceTemplateStore(file, (store) => {
    const configuration = findConfigurationRecord(store, scope);
    const variable = findVariable(configuration, variableId);
    configuration.environment = configuration.environment!.filter((candidate) => candidate !== variable);
    return workspaceTemplateEnvironmentVariableSummary(variable);
  });
}
