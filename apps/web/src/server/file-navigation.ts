import { posix } from "node:path";
import { openFileInBrowser } from "@agents-in-the-cloud/browser/server";
import { invalidArguments } from "@agents-in-the-cloud/core";
import { openFileInFiles } from "@agents-in-the-cloud/files/server";
import type { WorkspaceFileTarget, WorkspaceModuleRouteContext } from "@agents-in-the-cloud/shared";
import { listWorkspaceVSCodeViews, openFileInVSCode } from "@agents-in-the-cloud/vscode/server";
import { existingFilesInWorkspace, workspaceRoot } from "@agents-in-the-cloud/workspace";

export async function openWorkspaceFile(workspaceId: string, target: WorkspaceFileTarget, openWorkView: WorkspaceModuleRouteContext["openWorkView"], requireExisting = false): Promise<Response> {
  const path = posix.resolve(workspaceRoot, target.path);
  if (path === workspaceRoot) throw invalidArguments("Choose a file to open");
  if (requireExisting) {
    // Plain terminal paths are only guesses; do not create a tab for an
    // example, nonexistent proposal, or directory.
    if ((await existingFilesInWorkspace(workspaceId, "agents-in-the-cloud", [path])).length === 0) return new Response(null, { status: 204 });
  }
  if (/\.html?$/i.test(path) && !target.line) return openFileInBrowser(workspaceId, path, openWorkView, target.fragment);
  const resolvedTarget = { ...target, path };
  const vscode = listWorkspaceVSCodeViews(workspaceId)[0];
  return vscode
    ? openFileInVSCode(workspaceId, vscode.title, resolvedTarget, openWorkView)
    : openFileInFiles(workspaceId, resolvedTarget, openWorkView);
}
