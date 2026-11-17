import { randomUUID } from "node:crypto";
import { domId, escapeHtml, turboStream, type WorkspaceFileTarget } from "@agents-in-the-cloud/shared";

export function vscodeViewKey(title: string): string {
  return `vscode:${title}`;
}

export function renderVSCodeView(workspaceId: string, title: string): string {
  const key = vscodeViewKey(title);
  const escapedWorkspaceId = escapeHtml(workspaceId);
  return `<div id="${domId("vscode_view", workspaceId, title)}" data-turbo-permanent class="vscode-work-view" data-work-view-source="${escapeHtml(key)}">
    <div class="vscode-frame-shell vscode-loading">
      <iframe class="vscode-frame" data-controller="workspace-app-frame vscode-starting" data-workspace-app-frame-workspace-id-value="${escapedWorkspaceId}" data-workspace-app-frame-app-key-value="vscode" allow="clipboard-read; clipboard-write; fullscreen" allowfullscreen title="VS Code"></iframe>
      <div class="vscode-starting-screen" aria-live="polite">
        <div class="vscode-starting-card">
          <span class="status-spinner vscode-starting-spinner" aria-hidden="true"></span>
          <div class="vscode-starting-title">Starting VS Code</div>
        </div>
      </div>
    </div>
  </div>`;
}

export function renderVSCodeNavigationSignal(workspaceId: string): string {
  return `<span id="${domId("vscode_navigation", workspaceId)}" data-turbo-permanent hidden></span>`;
}

export function vscodeFileLocation(target: WorkspaceFileTarget): { file: string; gotoLine: boolean } {
  const line = target.line ?? (target.column ? 1 : undefined);
  return line ? { file: `${target.path}:${line}:${target.column ?? 1}`, gotoLine: true } : { file: target.path, gotoLine: false };
}

/**
 * Presents the file in this browser's VS Code frame. A frame whose window already
 * received the file (`delivered`) is left alone; any other frame (re)loads with it.
 */
export function vscodeFileNavigationStream(workspaceId: string, title: string, target: WorkspaceFileTarget, delivered: boolean): string {
  const { file, gotoLine } = vscodeFileLocation(target);
  const query = new URLSearchParams({
    agentsInTheCloudOpenFile: file,
    agentsInTheCloudNavigation: randomUUID(),
  });
  if (gotoLine) query.set("agentsInTheCloudGotoLine", "1");
  return turboStream("update", domId("vscode_navigation", workspaceId),
    `<span data-controller="vscode-navigate" data-vscode-navigate-view-id-value="${domId("vscode_view", workspaceId, title)}" data-vscode-navigate-path-value="${escapeHtml(`/?${query}`)}" data-vscode-navigate-delivered-value="${delivered}"></span>`);
}
