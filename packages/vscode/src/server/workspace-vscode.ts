import type { JsonValue } from "@agents-in-the-cloud/core";
import type { WorkspaceFileTarget } from "@agents-in-the-cloud/shared";
import { createWorkspaceMetadataState, execWorkspaceCommand, execWorkspaceShell } from "@agents-in-the-cloud/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { vscodeFileLocation } from "./render.ts";
import { vscodeOpenFileScript, vscodeStartupScript } from "./startup.ts";

const workspaceVSCodeViewSchema = Type.Object({
  title: Type.String({ pattern: "\\S" }),
});
const workspaceVSCodeViewsSchema = Type.Array(workspaceVSCodeViewSchema);

export type WorkspaceVSCodeView = Static<typeof workspaceVSCodeViewSchema>;

function defaultViews(): WorkspaceVSCodeView[] {
  return [];
}

function parseVSCodeViews(value: JsonValue): WorkspaceVSCodeView[] {
  if (!Value.Check(workspaceVSCodeViewsSchema, value)) throw new Error("invalid persisted VS Code views");
  return value.map(({ title }) => ({ title }));
}

const vscodeViews = createWorkspaceMetadataState("vscode-work-views.json", parseVSCodeViews, defaultViews);

export function listWorkspaceVSCodeViews(workspaceId: string): WorkspaceVSCodeView[] {
  return vscodeViews.read(workspaceId);
}

export function createWorkspaceVSCodeView(workspaceId: string): WorkspaceVSCodeView {
  const existing = listWorkspaceVSCodeViews(workspaceId);
  const used = new Set(existing.map((view) => view.title));
  let index = 1;
  let title = "VS Code";
  while (used.has(title)) {
    index += 1;
    title = `VS Code ${index}`;
  }
  const view = { title };
  existing.push(view);
  vscodeViews.write(workspaceId, existing);
  return view;
}

export function deleteWorkspaceVSCodeView(workspaceId: string, title: string): void {
  vscodeViews.write(workspaceId, vscodeViews.read(workspaceId).filter((view) => view.title !== title));
}

export function deleteWorkspaceVSCodeState(workspaceId: string): void {
  vscodeViews.delete(workspaceId);
}

export async function ensureWorkspaceVSCodeServer(workspaceId: string): Promise<void> {
  const workspaceFile = `/.agents-in-the-cloud/vscode/workspaces/${Buffer.from(workspaceId).toString("base64url")}.code-workspace`;
  const result = await execWorkspaceShell(workspaceId, vscodeStartupScript(workspaceFile), { user: "agents-in-the-cloud" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not start VS Code server for ${workspaceId}`);
}

export async function openFileInConnectedVSCodeWindows(workspaceId: string, target: WorkspaceFileTarget): Promise<boolean> {
  const { file, gotoLine } = vscodeFileLocation(target);
  const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", vscodeOpenFileScript(file, gotoLine)], { user: "agents-in-the-cloud" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not open ${file} in VS Code for ${workspaceId}`);
  return result.stdout.trim() === "delivered";
}
