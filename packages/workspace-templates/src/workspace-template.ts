import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { acquireFileLock, AgentsInTheCloudCoreError, getAgentsInTheCloudRuntimeContext, isNotFoundError, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceInitInstruction } from "@agents-in-the-cloud/workspace";

export type WorkspaceTemplateSummary = Omit<WorkspaceTemplateRecord, "secrets" | "sshKeys" | "sshKnownHosts" | "environment"> & {
  configurationFingerprint?: string;
  /** Adding a template counts as using it, as does creating a workspace from it. */
  lastUsedAt?: number;
};
export type StoredWorkspaceTemplateSecret = Static<typeof storedWorkspaceTemplateSecretSchema>;
/** workspaceTemplateId is absent for global entries. */
export type WorkspaceTemplateSecretSummary = Omit<StoredWorkspaceTemplateSecret, "projectId" | "encryptedSecret" | "annotation"> & { workspaceTemplateId?: string; annotation: string; configured: boolean };
export type StoredWorkspaceTemplateSshKey = Static<typeof storedWorkspaceTemplateSshKeySchema>;
export type WorkspaceTemplateSshKeySummary = Omit<StoredWorkspaceTemplateSshKey, "projectId" | "encryptedPrivateKey"> & { workspaceTemplateId?: string };
export type StoredWorkspaceTemplateEnvironmentVariable = Static<typeof workspaceTemplateEnvironmentVariableSchema>;
export type WorkspaceTemplateEnvironmentVariable = Omit<StoredWorkspaceTemplateEnvironmentVariable, "projectId"> & { workspaceTemplateId?: string };
export type WorkspaceTemplateRecord = Static<typeof workspaceTemplateRecordSchema>;
/** Records that own Secrets, SSH keys, trusted SSH servers and Environment variables. */
export type ConfigurationRecord = Static<typeof configurationRecordSchema>;
export type WorkspaceTemplateStore = { workspaceTemplates: WorkspaceTemplateRecord[]; global: ConfigurationRecord };

/** Global workspace settings apply to every new workspace; a template's own entry with the same name wins. */
export const globalWorkspaceConfiguration = { kind: "global" } as const;
/** A workspace template ID, or the global workspace settings. */
export type ConfigurationScope = string | typeof globalWorkspaceConfiguration;

export interface WorkspaceTemplateListResult {
  workspaceTemplates: WorkspaceTemplateSummary[];
}

export interface AddWorkspaceTemplateResult {
  workspaceTemplate: WorkspaceTemplateSummary;
}

export interface DeleteWorkspaceTemplateResult {
  workspaceTemplate: WorkspaceTemplateSummary;
}

export interface UpdateWorkspaceTemplateResult {
  workspaceTemplate: WorkspaceTemplateSummary;
}

// Serialized schemas retain their original keys: existing files and encrypted values need no migration.
// App-facing summaries expose workspaceTemplateId instead.
const storedWorkspaceTemplateSecretSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  envName: Type.String(),
  hostPattern: Type.String(),
  allowInPath: Type.Optional(Type.Boolean()),
  placeholder: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  encryptedSecret: Type.Optional(Type.String()),
  annotation: Type.Optional(Type.String()),
});

const workspaceTemplateEnvironmentVariableSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  name: Type.String(),
  value: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const storedWorkspaceTemplateSshKeySchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  keyType: Type.String(),
  name: Type.Optional(Type.String()),
  createdAt: Type.String(),
  encryptedPrivateKey: Type.String(),
});

const configurationProperties = {
  secrets: Type.Optional(Type.Array(storedWorkspaceTemplateSecretSchema)),
  sshKeys: Type.Optional(Type.Array(storedWorkspaceTemplateSshKeySchema)),
  sshKnownHosts: Type.Optional(Type.String()),
  environment: Type.Optional(Type.Array(workspaceTemplateEnvironmentVariableSchema)),
};

const configurationRecordSchema = Type.Object(configurationProperties);

const workspaceTemplateRecordSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  gitUrl: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  sessionShareKey: Type.String(),
  /** Absent on templates added before this was recorded. */
  createdAt: Type.Optional(Type.Number()),
  lastWorkspaceCreatedAt: Type.Optional(Type.Number()),
  swatchColor: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
  ...configurationProperties,
  privileged: Type.Optional(Type.Boolean()),
  seedConfigEnabled: Type.Optional(Type.Boolean()),
  dockerfile: Type.Optional(Type.String()),
  preloadImages: Type.Optional(Type.Array(Type.String())),
});

// This discriminator and projectId are part of the existing init.json format.
const gitWorkspaceTemplateInitSchema = Type.Object({
  type: Type.Literal("project.git"),
  configurationFingerprint: Type.Optional(Type.String()),
  projectId: Type.String(),
  name: Type.String(),
  gitUrl: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  sessionShareKey: Type.String(),
});

export type GitWorkspaceTemplateInitInstruction = Static<typeof gitWorkspaceTemplateInitSchema>;

declare module "@agents-in-the-cloud/workspace" {
  interface WorkspaceInitInstructionMap {
    "project.git": GitWorkspaceTemplateInitInstruction;
  }
}

const workspaceTemplateStoreSchema = Type.Object({
  projects: Type.Array(workspaceTemplateRecordSchema),
  /** Absent in files saved before global workspace settings existed. */
  global: Type.Optional(configurationRecordSchema),
});

export function workspaceTemplatesFile(dataDir = getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir): string {
  return join(dataDir, "projects.json");
}

export function workspaceTemplateNameFromGitUrl(url: string): string {
  const trimmed = url.trim().replace(/[/?#]+$/, "");
  const last = basename(trimmed);
  const withoutGit = last.endsWith(".git") ? last.slice(0, -4) : last;
  const safe = withoutGit.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe || safe === "." || safe === "..") throw new AgentsInTheCloudCoreError("invalid_git_url", `could not derive template name from ${url}`);
  return safe;
}

function workspaceTemplateId(gitUrl: string, branch: string | null): string {
  const base = workspaceTemplateNameFromGitUrl(gitUrl);
  const digest = createHash("sha256").update(`${gitUrl}\0${branch ?? ""}`).digest("hex").slice(0, 8);
  return `${base}-${digest}`;
}

export function formatWorkspaceTemplateSpec(workspaceTemplate: Pick<WorkspaceTemplateSummary, "gitUrl" | "branch">): string {
  return `${workspaceTemplate.gitUrl}${workspaceTemplate.branch ? `#${workspaceTemplate.branch}` : ""}`;
}

export function parseWorkspaceTemplateSpec(spec: string): { gitUrl: string; branch: string | null } {
  const trimmed = spec.trim();
  if (!trimmed) throw new AgentsInTheCloudCoreError("invalid_git_url", "git url is required");

  const normalized = /^github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  const [gitUrl, branch] = normalized.split(/#(.+)/, 2).map((part) => part.trim());
  return gitUrl && branch ? { gitUrl, branch } : { gitUrl: normalized, branch: null };
}

export async function readWorkspaceTemplateStore(file: string): Promise<WorkspaceTemplateStore> {
  try {
    const stored = Value.Parse(workspaceTemplateStoreSchema, JSON.parse(await readFile(file, "utf8")));
    const store: WorkspaceTemplateStore = { workspaceTemplates: stored.projects, global: stored.global ?? {} };
    // Ignore the retired requirement flag in older saved secrets.
    for (const workspaceTemplate of store.workspaceTemplates) for (const secret of workspaceTemplate.secrets ?? []) {
      Reflect.deleteProperty(secret, "optional");
    }
    // Older records may contain derived SSH metadata; keep only the encrypted key and its label.
    for (const workspaceTemplate of store.workspaceTemplates) for (const key of workspaceTemplate.sshKeys ?? []) {
      Reflect.deleteProperty(key, "publicKey");
      Reflect.deleteProperty(key, "fingerprint");
    }
    return store;
  } catch (error) {
    if (isNotFoundError(error)) return { workspaceTemplates: [], global: {} };
    throw error;
  }
}

const workspaceTemplateStoreListeners = new Set<() => void>();

export function onWorkspaceTemplateStoreChanged(listener: () => void): () => void {
  workspaceTemplateStoreListeners.add(listener);
  return () => { workspaceTemplateStoreListeners.delete(listener); };
}

/** Owns the complete read-modify-write operation so concurrent changes cannot overwrite one another. */
export async function updateWorkspaceTemplateStore<Result>(file: string, mutate: (store: WorkspaceTemplateStore) => Result | Promise<Result>): Promise<Result> {
  const release = await acquireFileLock(`${file}.lock`, "projects");
  try {
    const store = await readWorkspaceTemplateStore(file);
    const result = await mutate(store);
    // Preserve the existing on-disk envelope; this is serialization, not a data migration.
    await writeJsonAtomic(file, { projects: store.workspaceTemplates, global: store.global });
    for (const listener of workspaceTemplateStoreListeners) listener();
    return result;
  } finally {
    await release();
  }
}

export function findWorkspaceTemplateRecord(store: WorkspaceTemplateStore, workspaceTemplateId: string): WorkspaceTemplateRecord {
  const workspaceTemplate = store.workspaceTemplates.find((candidate) => candidate.id === workspaceTemplateId);
  if (!workspaceTemplate) throw new AgentsInTheCloudCoreError("workspace_template_not_found", `template not found: ${workspaceTemplateId}`);
  return workspaceTemplate;
}

export function isGlobalScope(scope: ConfigurationScope): scope is typeof globalWorkspaceConfiguration {
  return scope === globalWorkspaceConfiguration;
}

export function findConfigurationRecord(store: WorkspaceTemplateStore, scope: ConfigurationScope): ConfigurationRecord {
  return isGlobalScope(scope) ? store.global : findWorkspaceTemplateRecord(store, scope);
}

/** The scopes configuring a workspace, global first so a template's own entries win. Empty workspaces have no template. */
export function workspaceScopes(workspaceTemplateId?: string): ConfigurationScope[] {
  return workspaceTemplateId ? [globalWorkspaceConfiguration, workspaceTemplateId] : [globalWorkspaceConfiguration];
}

const globalConfigurationKey = "global";

/** Identifies a scope in stored records and encryption. Template IDs end in a digest, so they never equal the global key. */
export function configurationScopeKey(scope: ConfigurationScope): string {
  return isGlobalScope(scope) ? globalConfigurationKey : scope;
}

/** The workspaceTemplateId summary field for a stored record's projectId; absent for global entries. */
export function configurationScopeSummary(projectId: string): { workspaceTemplateId?: string } {
  return projectId === globalConfigurationKey ? {} : { workspaceTemplateId: projectId };
}

type FingerprintedConfiguration = Pick<ConfigurationRecord, "secrets" | "sshKnownHosts"> & { environment?: Pick<WorkspaceTemplateEnvironmentVariable, "name" | "value">[] };

function configurationSnapshot(configuration: FingerprintedConfiguration) {
  return {
    environment: (configuration.environment ?? []).map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)),
    secrets: (configuration.secrets ?? []).filter((secret) => secret.encryptedSecret).map(({ envName, hostPattern, placeholder, allowInPath, encryptedSecret }) => ({ envName, hostPattern, placeholder, allowInPath, encryptedSecret })).sort((a, b) => a.envName.localeCompare(b.envName)),
    sshKnownHosts: configuration.sshKnownHosts ?? "",
  };
}

export function workspaceTemplateConfigurationFingerprint(workspaceTemplate: Pick<WorkspaceTemplateRecord, "gitUrl" | "branch" | "dockerfile" | "privileged" | "seedConfigEnabled"> & FingerprintedConfiguration, global: FingerprintedConfiguration = {}): string {
  // Only workspace setup snapshots belong here; SSH keys are authorized live. Renaming a template
  // also changes its session share key, which is not worth warning existing workspaces about.
  const globalSnapshot = configurationSnapshot(global);
  const templateConfiguration = {
    gitUrl: workspaceTemplate.gitUrl, branch: workspaceTemplate.branch,
    privileged: workspaceTemplate.privileged ?? false,
    seedConfigEnabled: workspaceTemplate.seedConfigEnabled ?? false,
    dockerfile: workspaceTemplate.dockerfile ?? "",
    ...configurationSnapshot(workspaceTemplate),
  };
  // Omitted while empty, so fingerprints saved before global settings existed stay valid.
  const configuration = globalSnapshot.environment.length || globalSnapshot.secrets.length || globalSnapshot.sshKnownHosts ? { ...templateConfiguration, global: globalSnapshot } : templateConfiguration;
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

function workspaceTemplateSummary(workspaceTemplate: WorkspaceTemplateRecord, global: ConfigurationRecord): WorkspaceTemplateSummary {
  return {
    id: workspaceTemplate.id,
    name: workspaceTemplate.name,
    gitUrl: workspaceTemplate.gitUrl,
    branch: workspaceTemplate.branch,
    sessionShareKey: workspaceTemplate.sessionShareKey,
    swatchColor: workspaceTemplate.swatchColor,
    createdAt: workspaceTemplate.createdAt,
    lastWorkspaceCreatedAt: workspaceTemplate.lastWorkspaceCreatedAt,
    lastUsedAt: Math.max(workspaceTemplate.createdAt ?? 0, workspaceTemplate.lastWorkspaceCreatedAt ?? 0) || undefined,
    privileged: workspaceTemplate.privileged ?? false,
    seedConfigEnabled: workspaceTemplate.seedConfigEnabled ?? false,
    dockerfile: workspaceTemplate.dockerfile,
    preloadImages: [...(workspaceTemplate.preloadImages ?? [])],
    configurationFingerprint: workspaceTemplateConfigurationFingerprint(workspaceTemplate, global),
  };
}

export type WorkspaceTemplateConfiguration = WorkspaceTemplateSummary & {
  environment: WorkspaceTemplateEnvironmentVariable[];
  secrets: WorkspaceTemplateSecretSummary[];
};

export function workspaceTemplateSecretSummary(secret: StoredWorkspaceTemplateSecret): WorkspaceTemplateSecretSummary {
  const { encryptedSecret, projectId, ...metadata } = secret;
  return { ...metadata, ...configurationScopeSummary(projectId), annotation: secret.annotation ?? "", configured: !!encryptedSecret };
}

function workspaceTemplateSecretSummaries(configuration: ConfigurationRecord): WorkspaceTemplateSecretSummary[] {
  return (configuration.secrets ?? []).map(workspaceTemplateSecretSummary).sort((a, b) => a.envName.localeCompare(b.envName));
}

function workspaceTemplateEnvironmentVariableSummaries(configuration: ConfigurationRecord): WorkspaceTemplateEnvironmentVariable[] {
  return (configuration.environment ?? []).map(workspaceTemplateEnvironmentVariableSummary).sort((a, b) => a.name.localeCompare(b.name));
}

/** Non-sensitive settings derived from a single persisted template snapshot. */
export async function getWorkspaceTemplateConfiguration(workspaceTemplateId: string, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateConfiguration> {
  const store = await readWorkspaceTemplateStore(file);
  const workspaceTemplate = findWorkspaceTemplateRecord(store, workspaceTemplateId);
  return {
    ...workspaceTemplateSummary(workspaceTemplate, store.global),
    environment: workspaceTemplateEnvironmentVariableSummaries(workspaceTemplate),
    secrets: workspaceTemplateSecretSummaries(workspaceTemplate),
  };
}

export function workspaceTemplateSshKeySummary(key: StoredWorkspaceTemplateSshKey): WorkspaceTemplateSshKeySummary {
  const { encryptedPrivateKey: _, projectId, ...result } = key;
  return { ...result, ...configurationScopeSummary(projectId) };
}

export interface ScopeConfiguration {
  environment: WorkspaceTemplateEnvironmentVariable[];
  secrets: WorkspaceTemplateSecretSummary[];
  sshKeys: WorkspaceTemplateSshKeySummary[];
  sshKnownHosts: string;
}

/** Non-sensitive Secrets, SSH keys, trusted SSH servers and Environment variables of a template or the global workspace settings. */
export async function getConfiguration(scope: ConfigurationScope, file = workspaceTemplatesFile()): Promise<ScopeConfiguration> {
  const configuration = findConfigurationRecord(await readWorkspaceTemplateStore(file), scope);
  return {
    environment: workspaceTemplateEnvironmentVariableSummaries(configuration),
    secrets: workspaceTemplateSecretSummaries(configuration),
    sshKeys: (configuration.sshKeys ?? []).map(workspaceTemplateSshKeySummary),
    sshKnownHosts: configuration.sshKnownHosts ?? "",
  };
}

export async function listWorkspaceTemplates(file = workspaceTemplatesFile()): Promise<WorkspaceTemplateListResult> {
  const store = await readWorkspaceTemplateStore(file);
  const workspaceTemplates = [...store.workspaceTemplates].sort((a, b) => a.name.localeCompare(b.name) || (a.branch ?? "").localeCompare(b.branch ?? "") || a.gitUrl.localeCompare(b.gitUrl)).map((workspaceTemplate) => workspaceTemplateSummary(workspaceTemplate, store.global));
  return { workspaceTemplates };
}

export async function addWorkspaceTemplate(spec: string, file = workspaceTemplatesFile()): Promise<AddWorkspaceTemplateResult> {
  const { gitUrl, branch } = parseWorkspaceTemplateSpec(spec);
  const id = workspaceTemplateId(gitUrl, branch);
  return await updateWorkspaceTemplateStore(file, (store) => {
    if (store.workspaceTemplates.some((workspaceTemplate) => workspaceTemplate.id === id || (workspaceTemplate.gitUrl === gitUrl && workspaceTemplate.branch === branch))) {
      throw new AgentsInTheCloudCoreError("workspace_template_exists", `template already exists: ${formatWorkspaceTemplateSpec({ gitUrl, branch })}`);
    }
    const baseName = workspaceTemplateNameFromGitUrl(gitUrl);
    const name = store.workspaceTemplates.some((workspaceTemplate) => workspaceTemplate.gitUrl === gitUrl)
      ? `${baseName} (${branch ?? "default branch"})`
      : baseName;
    const workspaceTemplate = { id, name, gitUrl, branch, sessionShareKey: baseName, createdAt: Date.now() };
    store.workspaceTemplates.push(workspaceTemplate);
    return { workspaceTemplate: workspaceTemplateSummary(workspaceTemplate, store.global) };
  });
}

/** Retained independently of workspaces so parking or deletion cannot erase recency. */
export async function recordWorkspaceCreation(workspaceTemplateId: string, createdAt = Date.now(), file = workspaceTemplatesFile()): Promise<void> {
  await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, workspaceTemplateId);
    workspaceTemplate.lastWorkspaceCreatedAt = Math.max(workspaceTemplate.lastWorkspaceCreatedAt ?? 0, createdAt);
  });
}

export async function updateWorkspaceTemplate(id: string, values: { name: string; spec: string; swatchColor?: string }, file = workspaceTemplatesFile()): Promise<UpdateWorkspaceTemplateResult> {
  return await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, id);
    const name = values.name.trim();
    if (!name) throw new AgentsInTheCloudCoreError("invalid_arguments", "template name is required");
    const { gitUrl, branch } = parseWorkspaceTemplateSpec(values.spec);
    if (store.workspaceTemplates.some((candidate) => candidate.id !== id && candidate.gitUrl === gitUrl && candidate.branch === branch)) {
      throw new AgentsInTheCloudCoreError("workspace_template_exists", `template already exists: ${formatWorkspaceTemplateSpec({ gitUrl, branch })}`);
    }
    if (values.swatchColor !== undefined) {
      if (values.swatchColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(values.swatchColor)) throw new AgentsInTheCloudCoreError("invalid_arguments", "Swatch color must be a six-digit hex color");
      if (values.swatchColor === "") delete workspaceTemplate.swatchColor;
      else workspaceTemplate.swatchColor = values.swatchColor.toLowerCase();
    }
    workspaceTemplate.name = name;
    workspaceTemplate.gitUrl = gitUrl;
    workspaceTemplate.branch = branch;
    workspaceTemplate.sessionShareKey = name;
    return { workspaceTemplate: workspaceTemplateSummary(workspaceTemplate, store.global) };
  });
}

export async function deleteWorkspaceTemplate(id: string, file = workspaceTemplatesFile()): Promise<DeleteWorkspaceTemplateResult> {
  return await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, id);
    store.workspaceTemplates = store.workspaceTemplates.filter((candidate) => candidate.id !== id);
    return { workspaceTemplate: workspaceTemplateSummary(workspaceTemplate, store.global) };
  });
}

export function workspaceInitFromTemplate(workspaceTemplate: WorkspaceTemplateSummary): GitWorkspaceTemplateInitInstruction {
  return { type: "project.git", configurationFingerprint: workspaceTemplate.configurationFingerprint, projectId: workspaceTemplate.id, name: workspaceTemplate.name, gitUrl: workspaceTemplate.gitUrl, branch: workspaceTemplate.branch, sessionShareKey: workspaceTemplate.sessionShareKey };
}

/** Read the template identity from the unchanged persisted initialization format. */
export function workspaceTemplateIdFromInit(init: GitWorkspaceTemplateInitInstruction): string {
  return init.projectId;
}

export function workspaceTemplateEnvironmentVariableSummary(variable: StoredWorkspaceTemplateEnvironmentVariable): WorkspaceTemplateEnvironmentVariable {
  const { projectId, ...metadata } = variable;
  return { ...metadata, ...configurationScopeSummary(projectId) };
}

export function isGitWorkspaceTemplateInit(init: unknown): init is GitWorkspaceTemplateInitInstruction {
  return Value.Check(gitWorkspaceTemplateInitSchema, init);
}

/** The template a workspace was created from; empty workspaces have none. */
export function workspaceTemplateIdOfInit(init: WorkspaceInitInstruction | undefined): string | undefined {
  return isGitWorkspaceTemplateInit(init) ? workspaceTemplateIdFromInit(init) : undefined;
}

export function validateWorkspaceTemplateDockerfile(dockerfile: string): void {
  if (dockerfile.trim() && dockerfile.split("\n")[0]!.trim() !== "FROM agents-in-the-cloud-workspace") {
    throw new AgentsInTheCloudCoreError("invalid_arguments", "Dockerfile must start with FROM agents-in-the-cloud-workspace");
  }
}

export async function setWorkspaceTemplateDockerfile(id: string, dockerfile: string, file = workspaceTemplatesFile()): Promise<UpdateWorkspaceTemplateResult> {
  validateWorkspaceTemplateDockerfile(dockerfile);
  return await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, id);
    if (dockerfile.trim()) workspaceTemplate.dockerfile = dockerfile;
    else delete workspaceTemplate.dockerfile;
    return { workspaceTemplate: workspaceTemplateSummary(workspaceTemplate, store.global) };
  });
}

export function validateWorkspaceTemplatePreloadImage(image: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(image) || image.includes("://")) {
    throw new AgentsInTheCloudCoreError("invalid_arguments", `Invalid image reference: ${image || "(empty)"}`);
  }
}

/** Changes the preload set for future workspaces; existing workspace configuration is unchanged. */
export async function setWorkspaceTemplatePreloadImages(id: string, images: string[], file = workspaceTemplatesFile()): Promise<UpdateWorkspaceTemplateResult> {
  const preloadImages = [...new Set(images.map((image) => image.trim()))];
  preloadImages.forEach(validateWorkspaceTemplatePreloadImage);
  return await updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, id);
    workspaceTemplate.preloadImages = preloadImages;
    return { workspaceTemplate: workspaceTemplateSummary(workspaceTemplate, store.global) };
  });
}

/** Host-authorized opt-in; agent-editable workspace settings cannot grant privilege. */
export async function setWorkspaceTemplatePrivileged(id: string, privileged: boolean, file = workspaceTemplatesFile()): Promise<UpdateWorkspaceTemplateResult> {
  return updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, id);
    workspaceTemplate.privileged = privileged;
    return { workspaceTemplate: workspaceTemplateSummary(workspaceTemplate, store.global) };
  });
}

/** Only host template settings authorize exporting configuration into a workspace. */
export async function setWorkspaceTemplateSeedConfigEnabled(id: string, enabled: boolean, file = workspaceTemplatesFile()): Promise<UpdateWorkspaceTemplateResult> {
  return updateWorkspaceTemplateStore(file, (store) => {
    const workspaceTemplate = findWorkspaceTemplateRecord(store, id);
    workspaceTemplate.seedConfigEnabled = enabled;
    return { workspaceTemplate: workspaceTemplateSummary(workspaceTemplate, store.global) };
  });
}
