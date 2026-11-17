import type { JsonValue } from "@agents-in-the-cloud/core";
import { createWorkspaceMetadataState } from "@agents-in-the-cloud/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const filesViewSchema = Type.Object({
  id: Type.String(),
  path: Type.Optional(Type.String({ pattern: "^/" })),
  line: Type.Optional(Type.Number()),
  column: Type.Optional(Type.Number()),
  back: Type.Optional(Type.Array(Type.String({ pattern: "^/" }))),
  forward: Type.Optional(Type.Array(Type.String({ pattern: "^/" }))),
});
const filesViewsSchema = Type.Array(filesViewSchema);

export type FilesView = Static<typeof filesViewSchema>;
export const defaultFilesViewId = "workspace";
export type FilesHistoryDirection = "back" | "forward";
const maxHistoryEntries = 50;
const navigationRequests = new Map<string, string>();
export function filesNavigationRequest(workspaceId: string, id: string): string { return navigationRequests.get(`${workspaceId}:${id}`) ?? ""; }

function parseFilesViews(value: JsonValue): FilesView[] {
  if (!Value.Check(filesViewsSchema, value)) throw new Error("invalid persisted Files views");
  return value;
}

const filesViews = createWorkspaceMetadataState("files-work-views.json", parseFilesViews, () => [{ id: defaultFilesViewId }]);

export function listFilesViews(workspaceId: string): FilesView[] {
  const views = filesViews.read(workspaceId);
  if (views.some((view) => view.id === defaultFilesViewId)) return views;
  const withDefault = [{ id: defaultFilesViewId }, ...views];
  filesViews.write(workspaceId, withDefault);
  return withDefault;
}

function requireFilesView(views: FilesView[], id: string): FilesView {
  const view = views.find((candidate) => candidate.id === id);
  if (!view) throw new Error(`Files view not found: ${id}`);
  return view;
}

export function filesView(workspaceId: string, id: string): FilesView {
  return requireFilesView(listFilesViews(workspaceId), id);
}

export function setFilesViewFile(workspaceId: string, id: string, path?: string, position: { line?: number; column?: number } = {}): FilesView {
  const views = listFilesViews(workspaceId);
  const view = requireFilesView(views, id);
  if (view.path && path && view.path !== path) {
    view.back = [...(view.back ?? []), view.path].slice(-maxHistoryEntries);
    view.forward = [];
  }
  showFile(workspaceId, view, path, position);
  filesViews.write(workspaceId, views);
  return view;
}

export function navigateFilesViewHistory(workspaceId: string, id: string, direction: FilesHistoryDirection): void {
  const views = listFilesViews(workspaceId);
  const view = requireFilesView(views, id);
  const path = view[direction]?.pop();
  if (!path) return;
  const opposite = direction === "back" ? "forward" : "back";
  if (view.path) view[opposite] = [...(view[opposite] ?? []), view.path].slice(-maxHistoryEntries);
  showFile(workspaceId, view, path);
  filesViews.write(workspaceId, views);
}

export function forgetFilesPath(workspaceId: string, path: string): void {
  const views = listFilesViews(workspaceId);
  const kept = (entry: string) => entry !== path && !entry.startsWith(`${path}/`);
  for (const view of views) {
    if (view.back) view.back = view.back.filter(kept);
    if (view.forward) view.forward = view.forward.filter(kept);
  }
  filesViews.write(workspaceId, views);
}

function showFile(workspaceId: string, view: FilesView, path?: string, position: { line?: number; column?: number } = {}): void {
  navigationRequests.set(`${workspaceId}:${view.id}`, crypto.randomUUID());
  view.path = path;
  view.line = position.line;
  view.column = position.column;
}

export function createFilesView(workspaceId: string): FilesView {
  const views = listFilesViews(workspaceId);
  const view: FilesView = { id: crypto.randomUUID() };
  views.push(view);
  filesViews.write(workspaceId, views);
  return view;
}

export function closeFilesView(workspaceId: string, id: string): void {
  navigationRequests.delete(`${workspaceId}:${id}`);
  filesViews.write(workspaceId, filesViews.read(workspaceId).filter((view) => view.id !== id));
}

export function deleteFilesViewState(workspaceId: string): void {
  diskGenerations.delete(workspaceId);
  for (const key of navigationRequests.keys()) if (key.startsWith(`${workspaceId}:`)) navigationRequests.delete(key);
  filesViews.delete(workspaceId);
}

const diskGenerations = new Map<string, number>();
export function filesDiskGeneration(workspaceId: string): number { return diskGenerations.get(workspaceId) ?? 0; }
export function filesDiskChanged(workspaceId: string): void { diskGenerations.set(workspaceId, filesDiskGeneration(workspaceId) + 1); }
