import { maxChangesTextBytes, maxChangesTextLines } from "../editing.ts";
import { changesEdits, EditError } from "./editing.ts";
import { CommentConflict, InvalidComment, placeReviewComments, reviewComments } from "./comments.ts";
import { deletionCommentsId, renderDeletionComments, commentsActionsId, commentsModelId, orphanCommentsId, renderCommentActions, renderCommentsModel, renderOrphanComments } from "./comment-render.ts";
import { domId, type LiveRegion } from "@agents-in-the-cloud/shared";
import { changesDeletionReview, deletionReviewCommitResponse, deletionReviewFileResponse, clearDeletionReview } from "./deletion.ts";
import { refreshChanges } from "./refresh.ts";
import { commitLinkLabel, openCommitLink } from "./commit-links.ts";
import type { JsonValue } from "@agents-in-the-cloud/core";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml, parseCommitLinkSpec, turboStreamResponse, type WorkspaceModule } from "@agents-in-the-cloud/shared";
import { matchRoute, response, textResponse } from "@agents-in-the-cloud/shared/http";
import { workspaceRepository } from "@agents-in-the-cloud/workspace/git";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { collectUnchangedPaths, maxUnchangedMediaBytes, readUnchangedContents, readUnchangedFile, unchangedMediaType, type ChangesFile, type UnchangedFile } from "./diff.ts";
import { canEditFile } from "../editing.ts";
import { renderEditModel, renderUnchangedFile, renderUnchangedPaths, changesBodyId, comparisonId, errorId, historyContentId, renderChanges, renderChangesTitle, renderChangesFile, renderComparison, renderError, renderHistory, renderDiff, noticeId, renderNotice } from "./render.ts";
import type { DiffEndpoints } from "../history.ts";
import { workspaceChangeBuckets, type ChangeBucket } from "./buckets.ts";
import { ChangesPublication } from "./publication.ts";
import { captureChanges, commitHistory, InvalidDiffEndpoints, workingTree, type ChangesSnapshot } from "./snapshot.ts";

const reference = { type: "changes" } as const;
const referenceSchema = Type.Object({ type: Type.Literal("changes") });
type ChangesState = ChangesPublication<ChangesSnapshot> & { buckets: readonly ChangeBucket[]; clients: Map<string, number> };
let invalidateWorkspace: (workspaceId: string) => void;
const states = new Map<string, Promise<ChangesState>>();
function current(workspaceId: string): Promise<ChangesState> {
  let state = states.get(workspaceId);
  if (!state) {
    state = Promise.all([captureChanges(workspaceRepository(workspaceId)), workspaceChangeBuckets(workspaceId)]).then(([snapshot, buckets]) => {
      const clients = new Map<string, number>(), root = workspaceRepository(workspaceId);
      return Object.assign(new ChangesPublication(snapshot, {
        capture: previous => states.get(workspaceId) === state ? refreshChanges(root, previous) : Promise.resolve(previous),
        published: () => { if (states.get(workspaceId) !== state) return; clients.clear(); invalidateWorkspace(workspaceId); },
      }), { buckets, clients });
    });
    states.set(workspaceId, state);
    void state.catch(() => { if (states.get(workspaceId) === state) states.delete(workspaceId); });
  }
  return state;
}
const unchangedPaths = new WeakMap<ChangesSnapshot, Promise<Set<string>>>();
function unchanged(workspaceId: string, snapshot: ChangesSnapshot): Promise<Set<string>> {
  let paths = unchangedPaths.get(snapshot);
  if (!paths) {
    paths = snapshot.index.phase === "ready" ? collectUnchangedPaths(workspaceRepository(workspaceId), snapshot.target, new Set(snapshot.files.keys())).then(list => new Set(list)) : Promise.resolve(new Set());
    unchangedPaths.set(snapshot, paths);
    void paths.catch(() => { if (unchangedPaths.get(snapshot) === paths) unchangedPaths.delete(snapshot); });
  }
  return paths;
}
const isUnchanged = async (workspaceId: string, snapshot: ChangesSnapshot, path: string) => (await unchanged(workspaceId, snapshot)).has(path);
function editableUnchangedFile(snapshot: ChangesSnapshot, path: string, file: UnchangedFile): ChangesFile | undefined {
  return snapshot.endpoints.target === workingTree && file.kind === "text" ? { path, change: "modified", kind: "text", newContents: file.text, newMode: file.mode } : undefined;
}
const replace = (target: string, html: string) => `<turbo-stream action="replace" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
const diffEndpointsSchema = Type.Object({ target: Type.String(), base: Type.Optional(Type.Union([Type.String(), Type.Null()])) });
const requestSchema = Type.Object({ client: Type.String({ minLength: 1, maxLength: 64 }), sequence: Type.Integer({ minimum: 1 }), history: Type.String({ minLength: 1, maxLength: 64 }) });

const editedRangesSchema = Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), revision: Type.Integer({ minimum: 1 }), start: Type.Integer({ minimum: 1, maximum: maxChangesTextLines + 1 }), end: Type.Integer({ minimum: 1, maximum: maxChangesTextLines + 1 }) }), { maxItems: 10000 });
const editSaveSchema = Type.Object({ token: Type.String({ minLength: 1, maxLength: 64 }), contents: Type.String({ maxLength: maxChangesTextBytes }), ranges: editedRangesSchema, history: Type.String({ minLength: 1, maxLength: 64 }) });
const commentSaveSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }), revision: Type.Integer({ minimum: 0 }), body: Type.String({ maxLength: 10000 }),
  path: Type.Optional(Type.String({ minLength: 1 })), side: Type.Optional(Type.Union([Type.Literal("additions"), Type.Literal("deletions")])),
  start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })),
});
const commentVersionSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), revision: Type.Integer({ minimum: 1 }) });
const copiedSchema = Type.Array(commentVersionSchema);
function commentRegions(workspaceId: string, { snapshot, buckets }: ChangesState, key: string): LiveRegion[] {
  if (key !== snapshot.id) return [{ target: domId("changes", key, "diff"), html: renderDiff(workspaceId, snapshot, buckets, true), action: "replace", morph: false }];
  const comments = placeReviewComments(reviewComments.list(workspaceId), snapshot);
  return [
    { target: commentsModelId(key), html: renderCommentsModel(key, comments), action: "replace", morph: false },
    { target: orphanCommentsId(key), html: renderOrphanComments(key, comments), action: "replace" },
    { target: commentsActionsId(key), html: renderCommentActions(workspaceId, key, comments), action: "replace", morph: false },
  ];
}
function commentsResponse(workspaceId: string, state: ChangesState, key: string): Response {
  return turboStreamResponse(commentRegions(workspaceId, state, key).map(region => replace(region.target, region.html)).join(""));
}

export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "changes",
  deletionReview: changesDeletionReview,
  liveSurfaces: [{ name: "review-comments", async load({ workspaceId, key }) { return commentRegions(workspaceId, await current(workspaceId), key); } }],
  workViews: [{
    type: "changes",
    parseReference(value: JsonValue) {
      if (!Value.Check(referenceSchema, value)) throw new Error("Changes reference is invalid");
      return reference;
    },
    identity: () => "workspace",
    async render({ workspaceId }) {
      const state = await current(workspaceId);
      state.buckets = await workspaceChangeBuckets(workspaceId);
      return renderChanges(workspaceId, state.snapshot, state.buckets);
    },
  }],
  commands: [{ id: "changes.open", execute: () => ({ createdWorkView: reference }) }],
  staticFiles: { "/deletion.css": { url: new URL("../client/deletion.css", import.meta.url), contentType: "text/css; charset=utf-8" }, "/changes.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{ async handle(request, url, context) {
    const linkRoute = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/(open|commit-label)$/);
    if (linkRoute) {
      if (request.method !== "GET") return textResponse("Method not allowed", { status: 405 });
      const workspaceId = linkRoute[0]!, link = parseCommitLinkSpec(url.searchParams.get("commit") ?? "");
      if (!link) return textResponse("Invalid commit link", { status: 400 });
      const root = workspaceRepository(workspaceId);
      if (linkRoute[1] === "commit-label") {
        const label = await commitLinkLabel(root, link);
        return label === undefined ? response("Commit not found", { status: 404 }) : response(label, { headers: { "Cache-Control": "private, max-age=31536000, immutable" } });
      }
      const state = await current(workspaceId), ticket = state.select(), previous = state.snapshot;
      if (await state.publishSelection(ticket, () => openCommitLink(root, previous, link))) state.clients.clear();
      return await context.openWorkView(workspaceId, reference);
    }
    const noticeRoute = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/notice\/dismiss$/);
    if (noticeRoute) {
      if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
      const workspaceId = noticeRoute[0]!, { snapshot } = await current(workspaceId), history = String((await request.formData()).get("history"));
      if (history === snapshot.history.id) snapshot.notice = undefined;
      return turboStreamResponse(replace(noticeId(workspaceId, history), renderNotice(workspaceId, history)));
    }
    const editRoute = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/edit\/(begin|save|cancel)$/);
    if (editRoute) {
      if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
      const workspaceId = editRoute[0]!, operation = editRoute[1]!, data = await request.formData();
      try {
        if (operation === "begin") {
          const { snapshot } = await current(workspaceId);
          if (data.get("snapshot") !== snapshot.id) throw new EditError("This comparison changed. Refresh Changes before editing.", 409);
          const path = data.get("path");
          if (!Value.Check(Type.String({ minLength: 1, maxLength: 4096 }), path)) throw new EditError("Choose a file to edit.", 400);
          const file = snapshot.files.get(path) ?? (await isUnchanged(workspaceId, snapshot, path) ? editableUnchangedFile(snapshot, path, await readUnchangedFile(workspaceRepository(workspaceId), undefined, path)) : undefined);
          const model = await changesEdits.begin(workspaceId, workspaceRepository(workspaceId), snapshot, path, file);
          return response(renderEditModel(model));
        }
        const token = data.get("token");
        if (!Value.Check(Type.String({ minLength: 1, maxLength: 64 }), token)) throw new EditError("Invalid edit session.", 400);
        if (operation === "cancel") { changesEdits.cancel(workspaceId, token); return new Response(null, { status: 204 }); }
        let ranges: unknown;
        try { ranges = JSON.parse(String(data.get("ranges"))); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new EditError("Invalid comment positions.", 400); }
        const input = { token, contents: data.get("contents"), ranges, history: data.get("history") };
        if (!Value.Check(editSaveSchema, input) || input.ranges.some(range => range.end < range.start)) throw new EditError("Invalid file edit.", 400);
        const state = await current(workspaceId), root = workspaceRepository(workspaceId), ticket = state.select();
        let saved: ChangesSnapshot | undefined;
        let published: ChangesSnapshot | undefined;
        try {
          published = await state.publishSelection(ticket, async () => saved = saved
            ? await refreshChanges(root, saved)
            : await changesEdits.save(workspaceId, root, input.token, input.contents, input.ranges,
              (snapshot, path, contents, positions) => reviewComments.relocate(workspaceId, snapshot, path, contents, positions)));
        } catch (error) {
          if (!saved) throw error;
          console.error("Could not refresh Changes after a save", error);
        }
        if (published) state.clients.clear();
        invalidateWorkspace(workspaceId);
        // Unpublished: a later selection may not show the saved file (it may have captured before the save, or fail),
        // or capturing failed; refresh for it. The file is written either way, so a failed refresh doesn't fail the save.
        if (!published) await state.changed().catch(error => console.error("Could not refresh Changes after a save", error));
        const next = published ?? await state.settled();
        return turboStreamResponse(replace(changesBodyId(workspaceId, input.history), renderChanges(workspaceId, next, state.buckets)));
      } catch (error) {
        if (!(error instanceof EditError)) throw error;
        return textResponse(error.message, { status: error.status });
      }
    }
    const commentRoute = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/comments\/(save|delete|delete-many|copied)$/);
    if (commentRoute) {
      if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
      const workspaceId = commentRoute[0]!, operation = commentRoute[1]!;
      const data = await request.formData();
      const state = await current(workspaceId), { snapshot } = state;
      const key = String(data.get("snapshot") ?? snapshot.id);
      try {
        if (operation === "copied" || operation === "delete-many") {
          let versions: unknown;
          try { versions = JSON.parse(String(data.get("versions"))); }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; return textResponse("Invalid comment revisions", { status: 400 }); }
          if (!Value.Check(copiedSchema, versions)) return textResponse("Invalid comment revisions", { status: 400 });
          if (operation === "copied") reviewComments.markCopied(workspaceId, versions);
          else reviewComments.removeMany(workspaceId, versions);
        } else if (operation === "delete") {
          const version = { id: data.get("id"), revision: Number(data.get("revision")) };
          if (!Value.Check(commentVersionSchema, version)) return textResponse("Invalid comment revision", { status: 400 });
          reviewComments.remove(workspaceId, version.id, version.revision);
        } else {
          const input = {
            id: data.get("id"), revision: Number(data.get("revision")), body: data.get("body"),
            path: data.get("path") ?? undefined, side: data.get("side") ?? undefined,
            start: data.has("start") ? Number(data.get("start")) : undefined,
            end: data.has("end") ? Number(data.get("end")) : undefined,
          };
          if (!Value.Check(commentSaveSchema, input)) return textResponse("Invalid comment", { status: 400 });
          if (input.revision === 0 && key !== snapshot.id) return textResponse("This comparison changed. Your text is still here; refresh Changes before adding this comment.", { status: 409 });
          reviewComments.save(workspaceId, input, snapshot);
        }
      } catch (error) {
        if (!(error instanceof CommentConflict) && !(error instanceof InvalidComment)) throw error;
        return textResponse(error.message, { status: error instanceof CommentConflict ? 409 : 422 });
      }
      invalidateWorkspace(workspaceId);
      return operation === "copied" ? turboStreamResponse(replace(deletionCommentsId(workspaceId), renderDeletionComments(workspaceId, reviewComments.list(workspaceId)))) : commentsResponse(workspaceId, state, key);
    }
    let match = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/deletion\/file$/);
    if (match) return request.method === "GET" ? await deletionReviewFileResponse(match[0]!, url) : textResponse("Method not allowed", { status: 405 });
    match = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/deletion\/commit$/);
    if (match) return request.method === "GET" ? await deletionReviewCommitResponse(match[0]!, url) : textResponse("Method not allowed", { status: 405 });
    match = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/(file|image|unchanged|unchanged-media)$/);
    if (match) {
      if (request.method !== "GET") return textResponse("Method not allowed", { status: 405 });
      const workspaceId = match[0]!, { snapshot } = await current(workspaceId);
      if (url.searchParams.get("snapshot") !== snapshot.id) return textResponse("This comparison has changed. Reopen Changes to load the current snapshot.", { status: 409 });
      if (match[1] === "unchanged") return response(renderUnchangedPaths([...await unchanged(workspaceId, snapshot)]));
      const path = url.searchParams.get("path") ?? "";
      if (match[1] === "unchanged-media") {
        const contentType = unchangedMediaType(path);
        if (!contentType || !await isUnchanged(workspaceId, snapshot, path)) return textResponse("Unchanged file not found", { status: 404 });
        const { contents } = await readUnchangedContents(workspaceRepository(workspaceId), snapshot.target, path, maxUnchangedMediaBytes);
        if (!contents) return textResponse("This file is too large to preview here.", { status: 413 });
        return new Response(new Uint8Array(contents), { headers: {
          "Content-Type": contentType, "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        } });
      }
      const file = snapshot.files.get(path);
      if (!file && match[1] === "file" && await isUnchanged(workspaceId, snapshot, path)) {
        const unchangedFile = await readUnchangedFile(workspaceRepository(workspaceId), snapshot.target, path);
        const editable = editableUnchangedFile(snapshot, path, unchangedFile);
        return response(renderUnchangedFile(workspaceId, snapshot.id, path, unchangedFile, editable !== undefined && canEditFile(editable)));
      }
      if (!file) return textResponse("Changed file not found", { status: 404 });
      if (match[1] === "file") return response(renderChangesFile(file, snapshot.id, snapshot.endpoints.target === "working"));
      const side = url.searchParams.get("side");
      if (side !== "before" && side !== "after") return textResponse("Invalid image side", { status: 400 });
      const image = file.images?.[side];
      return image ? new Response(new Uint8Array(image.contents), { headers: {
        "Content-Type": image.contentType, "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      } }) : textResponse("Image not found", { status: 404 });
    }
    match = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/history$/);
    if (match) {
      if (request.method !== "GET") return textResponse("Method not allowed", { status: 405 });
      const workspaceId = match[0]!, state = await current(workspaceId), history = state.snapshot.history;
      if (url.searchParams.get("history") !== history.id) return textResponse("This history has been refreshed.", { status: 409 });
      const skip = Number(url.searchParams.get("skip"));
      if (!Number.isInteger(skip) || skip !== history.loaded) return textResponse("Invalid history page", { status: 400 });
      const page = await commitHistory(workspaceRepository(workspaceId), history, skip);
      if (state.snapshot.history !== history || history.loaded !== skip) return new Response(null, { status: 204 });
      history.commits.push(...page.commits);
      history.loaded += page.commits.length;
      history.hasMore = page.hasMore;
      return turboStreamResponse(replace(historyContentId(history), renderHistory(state.snapshot)));
    }
    match = matchRoute(url, /^\/workspaces\/([^/]+)\/changes\/(refresh|compare)$/);
    if (!match) return undefined;
    if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
    const workspaceId = match[0]!, state = await current(workspaceId), previous = state.snapshot;
    const data = await request.formData();
    const order = { client: data.get("client"), sequence: Number(data.get("sequence")), history: data.get("history") };
    if (!Value.Check(requestSchema, order)) return textResponse("Invalid comparison request", { status: 400 });
    if (order.sequence <= (state.clients.get(order.client) ?? 0)) return new Response(null, { status: 204 });
    state.clients.set(order.client, order.sequence);
    const ticket = state.select();
    let buckets: readonly ChangeBucket[] = state.buckets;
    const shown = order.history, upToDate = shown === previous.history.id;
    const requestedEndpoints = { target: data.get("end"), base: data.has("start") ? data.get("start") === "" ? null : data.get("start") : undefined };
    let next: ChangesSnapshot | undefined;
    try {
      if (!Value.Check(diffEndpointsSchema, requestedEndpoints)) throw new InvalidDiffEndpoints("Invalid comparison endpoints.");
      const endpoints: DiffEndpoints = requestedEndpoints;
      const root = workspaceRepository(workspaceId);
      // An older history is refreshed. A comparison picked or refreshed there still wins when its commits survived.
      // Changes refreshing because it was shown follows the server instead: a commit link that just opened it
      // replaced the comparison, and its live update may not have reached this browser yet.
      const kept = upToDate || data.get("shown") !== "true";
      next = await state.publishSelection(ticket, async outdated => {
        let snapshot: ChangesSnapshot;
        [snapshot, buckets] = await Promise.all([
          match[1] === "compare" && upToDate && !outdated ? captureChanges(root, endpoints, previous.history) : refreshChanges(root, previous, kept ? endpoints : previous.endpoints),
          workspaceChangeBuckets(workspaceId),
        ]);
        return snapshot;
      });
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      const invalid = error instanceof InvalidDiffEndpoints;
      if (!invalid) console.error(`Could not ${match[1]} Changes for workspace ${workspaceId}`, error);
      if (state.superseded(ticket)) return new Response(null, { status: 204 });
      return turboStreamResponse(replace(errorId(workspaceId, shown), renderError(workspaceId, shown, invalid ? error.message : `Couldn’t generate this comparison: ${error.message}`)), { status: invalid ? 422 : 500 });
    }
    if (!next) return new Response(null, { status: 204 });
    state.buckets = buckets;
    invalidateWorkspace(workspaceId);
    if (next.history.id !== shown) {
      state.clients.clear();
      return turboStreamResponse(replace(changesBodyId(workspaceId, shown), renderChanges(workspaceId, next, state.buckets, data.get("pickerOpen") === "true")));
    }
    return turboStreamResponse(replace(comparisonId(workspaceId, shown), renderComparison(workspaceId, next, state.buckets, true)) + replace(errorId(workspaceId, shown), renderError(workspaceId, shown)));
  } }],
  initialize(context) {
    invalidateWorkspace = context.invalidateWorkspace;
    context.events.on("workspace_agent_turn_finished", async ({ workspaceId }) => { await (await current(workspaceId)).changed(); });
    context.events.on("workspace_delete_inspect", ({ workspaceId, issues }) => {
      const uncopied = reviewComments.list(workspaceId).filter(comment => comment.copiedRevision !== comment.revision);
      if (uncopied.length) issues.push({ kind: "uncopied_review_comments", message: `${uncopied.length} review comments haven’t been copied. Deleting this workspace will delete them.`, count: uncopied.length });
    });
    context.onWorkspaceRemoved(workspaceId => { states.delete(workspaceId); changesEdits.delete(workspaceId); clearDeletionReview(workspaceId); reviewComments.delete(workspaceId); });
  },
  async attachToWorkspace({ workspaceId }) {
    const { snapshot } = await current(workspaceId);
    return {
      workViews: [{ reference, sourceKey: "changes:workspace", label: renderChangesTitle(snapshot), kind: "contextual", iconHtml: Icons.Changes, availability: { phase: "live" }, initiallyOpen: false }],
      commands: [{ id: "changes.open", label: "Changes", description: "Compare local commits and uncommitted changes.", scope: "workspace", surfaces: { ui: { placement: "work-launcher", iconHtml: Icons.Changes, label: "Changes" }, shortcut: { defaultBinding: "Meta+Alt+KeyC" } } }],
    };
  },
};
