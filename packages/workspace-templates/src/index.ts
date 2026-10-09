export {
  addWorkspaceTemplate,
  onWorkspaceTemplateStoreChanged,
  deleteWorkspaceTemplate,
  formatWorkspaceTemplateSpec,
  getWorkspaceTemplateConfiguration,
  getConfiguration,
  globalWorkspaceConfiguration,
  isGlobalScope,
  type ConfigurationScope,
  type ScopeConfiguration,
  isGitWorkspaceTemplateInit,
  workspaceTemplateIdFromInit,
  workspaceTemplateIdOfInit,
  listWorkspaceTemplates,
  parseWorkspaceTemplateSpec,
  workspaceInitFromTemplate,
  updateWorkspaceTemplate,
  setWorkspaceTemplateDockerfile,
  setWorkspaceTemplatePrivileged,
  setWorkspaceTemplateSeedConfigEnabled,
  setWorkspaceTemplatePreloadImages,
  type GitWorkspaceTemplateInitInstruction,
  type WorkspaceTemplateConfiguration,
  type WorkspaceTemplateEnvironmentVariable,
  type WorkspaceTemplateSecretSummary,
  type WorkspaceTemplateSshKeySummary,
  type WorkspaceTemplateSummary,
} from "./workspace-template.ts";

export {
  createWorkspaceTemplateSshKey,
  deleteWorkspaceTemplateSshKey,
  deriveWorkspaceTemplateSshPublicKey,
  revealEffectiveSshKeys,
  renameWorkspaceTemplateSshKey,
  revealWorkspaceTemplateSshKeys,
} from "./ssh-keys.ts";

export {
  createWorkspaceTemplateEnvironmentVariable,
  deleteWorkspaceTemplateEnvironmentVariable,
  effectiveEnvironment,
  updateWorkspaceTemplateEnvironmentVariable,
} from "./environment.ts";

export {
  createWorkspaceTemplateSecret,
  deleteWorkspaceTemplateSecret,
  revealEffectiveSecrets,
  revealWorkspaceTemplateSecrets,
  updateWorkspaceTemplateSecret,
  workspaceTemplateSecretPlaceholder,
  workspaceTemplateSecretPathPermissionSchema,
  type WorkspaceTemplateSecretInput,
} from "./secrets.ts";

export {
  clearCommitIdentity,
  getCommitIdentity,
  getStoredCommitIdentity,
  setCommitIdentity,
} from "./commit-identity.ts";

export {
  cachedWorkspaceTemplateSourcePath,
} from "./workspace-source.ts";

export { getWorkspaceTemplateSshKnownHosts, setWorkspaceTemplateSshKnownHosts } from "./ssh-host-trust.ts";
export { sshHostTrustFailure, scanSshHost, trustScannedSshHost } from "./ssh-trust-recovery.ts";
export { onWorkspaceSshTrustChanged, workspaceSshTrustRequests, requestWorkspaceSshTrust, decideWorkspaceSshTrust, cancelWorkspaceSshTrust } from "./ssh-trust-broker.ts";
export { isSshAuthenticationFailure } from "./git-access-failure.ts";

export { workspaceTemplateSecretHosts, workspaceTemplateSecretAllowsPath } from "./secret-path-policy.ts";
