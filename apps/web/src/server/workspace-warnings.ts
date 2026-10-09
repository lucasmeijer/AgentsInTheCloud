import { createHash } from "node:crypto";
import { isGitWorkspaceTemplateInit, workspaceTemplateIdFromInit, type WorkspaceTemplateConfiguration } from "@agents-in-the-cloud/workspace-templates";
import type { WorkspaceEntry, WorkspaceIssueKind } from "./workspace-registry.ts";

export interface WorkspaceWarning {
  kind: string;
  state: string;
  title?: string;
  message: string;
  action?: { href: string; caption: string };
}

const issueTitles = {
  readiness: "Workspace preparation needs attention",
  image: "Workspace image needs attention",
  // The naming message explains itself; a title would only add height.
  naming: undefined,
} satisfies Record<WorkspaceIssueKind, string | undefined>;

/** Current warning conditions. Stable state tokens scope acknowledgement to the specific problem. */
export function workspaceWarnings(entry: WorkspaceEntry, workspaceTemplate: WorkspaceTemplateConfiguration | undefined): WorkspaceWarning[] {
  const warnings: WorkspaceWarning[] = [];
  function add(kind: string, title: string | undefined, message: string, state: string, action?: WorkspaceWarning["action"]): void {
    warnings.push({ kind, title, message, state: createHash("sha256").update(state).digest("hex"), action });
  }
  if (isGitWorkspaceTemplateInit(entry.init)) {
    const workspaceTemplateId = workspaceTemplateIdFromInit(entry.init);
    const configuration = workspaceTemplate!;
    // Older workspaces have no fingerprint; do not claim to know whether their settings changed.
    if (entry.init.configurationFingerprint && entry.init.configurationFingerprint !== configuration.configurationFingerprint) {
      // The kind is persisted with dismissals, so it keeps its original name.
      // This identifier is persisted with dismissed warnings; keep it stable.
      add("project-settings-changed", "Template settings have changed", "Secrets and SSH keys already apply to this workspace. Other changes only apply to new workspaces.", configuration.configurationFingerprint!, { href: `/workspace-templates/${encodeURIComponent(workspaceTemplateId)}/settings`, caption: "Template settings" });
    }
  }
  for (const issue of entry.issues ?? []) add(issue.kind, issueTitles[issue.kind], issue.message, issue.message);
  if (entry.imageOutdated && !warnings.some((warning) => warning.kind === "image")) add("image", "Workspace image is outdated", "New workspaces get a newer image, after an AgentsInTheCloud update or a Dockerfile change. Make a new workspace to use it.", "outdated");
  return warnings;
}
