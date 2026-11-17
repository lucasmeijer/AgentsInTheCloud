import { createHash } from "node:crypto";
import { isGitWorkspaceTemplateInit, workspaceTemplateIdFromInit, type WorkspaceTemplateConfiguration } from "@agents-in-the-cloud/workspace-templates";
import type { WorkspaceEntry, WorkspaceWarningKind } from "./workspace-registry.ts";

export interface WorkspaceWarning {
  kind: string;
  state: string;
  title?: string;
  message: string;
  action?: { href: string; caption: string };
}

export const outdatedImageMessage = "Some new features might not be available in this workspace, because it was created in an older version.";

const warningTitles = {
  preparation: "Workspace preparation needs attention",
  image: "Workspace image needs attention",
  naming: undefined,
} satisfies Record<WorkspaceWarningKind, string | undefined>;

export function workspaceWarnings(entry: WorkspaceEntry, workspaceTemplate: WorkspaceTemplateConfiguration | undefined): WorkspaceWarning[] {
  const warnings: WorkspaceWarning[] = [];
  function add(kind: string, title: string | undefined, message: string, state: string, action?: WorkspaceWarning["action"]): void {
    warnings.push({ kind, title, message, state: createHash("sha256").update(state).digest("hex"), action });
  }
  if (isGitWorkspaceTemplateInit(entry.init)) {
    const workspaceTemplateId = workspaceTemplateIdFromInit(entry.init);
    const configuration = workspaceTemplate!;
    if (entry.init.configurationFingerprint && entry.init.configurationFingerprint !== configuration.configurationFingerprint) {
      // The kind is persisted with dismissals, so it keeps its original name.
      // This identifier is persisted with dismissed warnings; keep it stable.
      add("project-settings-changed", "Template settings have changed", "Secrets and SSH keys already apply to this workspace. Other changes only apply to new workspaces.", configuration.configurationFingerprint!, { href: `/workspace-templates/${encodeURIComponent(workspaceTemplateId)}/settings`, caption: "Template settings" });
    }
  }
  for (const warning of entry.warnings ?? []) add(warning.kind, warningTitles[warning.kind], warning.message, warning.message);
  return warnings;
}
