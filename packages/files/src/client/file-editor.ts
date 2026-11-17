import { setToggleValue, type ToggleChangeEvent } from "@agents-in-the-cloud/design-system/toggle/client";
import { errorMessage, type WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";
import { pierreHighlightOptions } from "@agents-in-the-cloud/syntax/diff-options";
import type { CodeView, CodeViewFileItem, CodeViewOptions } from "@pierre/diffs";
import type { Editor, EditorChangeEvent, EditorType } from "@pierre/diffs/edit";
import { editFileText, editorText } from "../editable-text.ts";
import { FileDraft } from "../file-draft.ts";
import { parseEditableFileResponse, parseFileSaveResponse, type EditableFileResponse } from "../protocol.ts";

const drafts = new Map<string, FileDraft>();
const wrapStorageKey = "agents-in-the-cloud:file-editor-wrap";
const backupErrors = new WeakMap<FileDraft, string>();

function fileDraft(url: string, file: EditableFileResponse): FileDraft {
  const existing = drafts.get(url);
  if (existing) {
    existing.changedOnDisk(file);
    return existing;
  }
  const key = `agents-in-the-cloud:file-draft:${url}`;
  const stored = localStorage.getItem(key);
  let base = file;
  let content = file.content;
  if (stored) {
    const value = JSON.parse(stored);
    base = parseEditableFileResponse(value.base);
    content = parseEditableFileResponse(value.draft).content;
  }
  const draft = new FileDraft(base, async (request) => {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(request),
    });
    if (response.status === 409) return { conflict: parseEditableFileResponse(await response.json()) };
    if (!response.ok) throw new Error(await response.text());
    return parseFileSaveResponse(await response.json());
  });
  draft.edit(content);
  draft.listeners.add(() => {
    try {
      if (draft.dirty) {
        const base = { content: draft.savedContent, revision: draft.revision, writable: file.writable };
        localStorage.setItem(key, JSON.stringify({ base, draft: { ...base, content: draft.content } }));
      } else localStorage.removeItem(key);
      backupErrors.delete(draft);
    } catch (error) {
      backupErrors.set(draft, `Draft backup failed: ${errorMessage(error)}. Keep this tab open until saved.`);
    }
  });
  drafts.set(url, draft);
  draft.changedOnDisk(file);
  return draft;
}

// Tint the caret's line instead of Pierre's outline. Unsafe CSS sits in a lower cascade
// layer than Pierre's editor styles, so the overrides must be important.
const editorCSS = `[data-line][data-editor-active-line]::after { box-shadow: none !important; } [data-line][data-editor-active-line] { background-color: color-mix(in srgb, var(--diffs-fg) 4%, transparent) !important; }`;

type EditorRefreshDetail = { workspaceId: string };

export function createFileEditorController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FileEditorController extends Controller {
    static values = { workspaceId: String, path: String, filesView: String, contentUrl: String, line: Number, column: Number, positionRequest: String };
    static targets = ["host", "loading", "status", "conflict", "conflictMine", "conflictTheirs", "renderedMarkdown", "markdownDisplayOptions", "copyButton", "wrapToggle"];

    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly pathValue: string;
    declare readonly filesViewValue: string;
    declare readonly contentUrlValue: string;
    declare readonly lineValue: number;
    declare readonly columnValue: number;
    declare readonly hostTarget: HTMLElement;
    declare readonly loadingTarget: HTMLElement;
    declare readonly statusTarget: HTMLElement;
    declare readonly conflictTarget: HTMLDialogElement;
    declare readonly conflictMineTarget: HTMLTextAreaElement;
    declare readonly conflictTheirsTarget: HTMLTextAreaElement;
    declare readonly renderedMarkdownTarget: HTMLElement;
    declare readonly markdownDisplayOptionsTarget: HTMLElement;
    declare readonly copyButtonTarget: HTMLButtonElement;
    declare readonly wrapToggleTarget: HTMLButtonElement;
    declare readonly hasRenderedMarkdownTarget: boolean;

    private viewer?: CodeView;
    private editor?: Editor<EditorType>;
    private options: CodeViewOptions<undefined, undefined> = {};
    private text = "";
    private writable = false;
    private version = 0;
    private wrap = true;
    private connection!: AbortController;
    private markdownRenderSequence = 0;
    private draft?: FileDraft;
    private saveTimer?: ReturnType<typeof setTimeout>;
    private applyingDisk = false;
    private saveSequence = 0;
    private diskSequence = 0;

    connect(): void {
      this.connection = new AbortController();
      const { signal } = this.connection;
      this.loadingTarget.hidden = false;
      this.loadingTarget.classList.remove("is-error");
      this.loadingTarget.querySelector("span")!.textContent = "Loading file…";
      this.copyButtonTarget.disabled = true;
      this.copyButtonTarget.dataset.copyText = "";
      this.setStatus("Loading…", "");
      this.wrap = localStorage.getItem(wrapStorageKey) !== "false";
      this.wrapToggleTarget.setAttribute("aria-checked", String(this.wrap));
      this.showSource();
      window.addEventListener("beforeunload", (event) => {
        if ([...drafts.values()].some((draft) => draft.dirty)) {
          event.preventDefault();
          event.returnValue = "";
        }
      }, { signal });
      // SAFETY: The files-refresh event carries EditorRefreshDetail.
      window.addEventListener("agents-in-the-cloud:files-refresh", this.refreshRequested as EventListener, { signal });
      this.element.addEventListener("agents-in-the-cloud:file-editor-refresh", this.refreshDisk, { signal });
      void this.load(signal).catch((error: Error) => {
        if (this.isCurrentConnection(signal)) this.showLoadError(error);
      });
    }

    disconnect(): void {
      this.connection.abort();
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.markdownRenderSequence++;
      this.draft?.listeners.delete(this.renderDraft);
      const draft = this.draft;
      if (draft) void draft.flush().then(() => {
        if (!draft.dirty && draft.listeners.size === 1 && drafts.get(this.contentUrlValue) === draft) drafts.delete(this.contentUrlValue);
      });
      this.saveTimer = undefined;
      this.viewer?.cleanUp();
      this.viewer = undefined;
      this.editor = undefined;
      this.conflictTarget.close();
    }

    useMine(): Promise<void> {
      return this.save(true);
    }

    async selectMarkdownDisplayMode(event: ToggleChangeEvent): Promise<void> {
      if (event.detail.value === "rendered") {
        if (this.renderedMarkdownTarget.hidden) await this.showRenderedMarkdown();
      } else {
        this.showSource();
      }
    }

    toggleWrap(): void {
      this.wrap = !this.wrap;
      localStorage.setItem(wrapStorageKey, String(this.wrap));
      this.wrapToggleTarget.setAttribute("aria-checked", String(this.wrap));
      this.options = { ...this.options, overflow: this.wrap ? "wrap" : "scroll" };
      this.viewer?.setOptions(this.options);
    }

    useTheirs(): void {
      this.draft!.accept(this.draft!.conflict!);
    }

    private isCurrentConnection(signal: AbortSignal): boolean {
      // Disconnect aborts this connection's signal, even across reconnects.
      // DOM removal can precede Stimulus delivering disconnect().
      return !signal.aborted && this.element.isConnected;
    }

    private async load(signal: AbortSignal): Promise<void> {
      const [file, [{ CodeView }, { Editor }]] = await Promise.all([
        this.fetchFile(signal),
        Promise.all([import("@pierre/diffs"), import("@pierre/diffs/edit"), import("@agents-in-the-cloud/syntax/pierre")]),
      ]);
      if (!this.isCurrentConnection(signal)) return;
      this.draft = fileDraft(this.contentUrlValue, file);
      this.loadingTarget.hidden = true;
      this.text = editorText(this.draft.content);
      this.writable = file.writable;
      this.options = {
        ...pierreHighlightOptions,
        overflow: this.wrap ? "wrap" : "scroll",
        disableFileHeader: true,
        disableLineNumbers: true,
        layout: { paddingTop: 12, paddingBottom: 40, gap: 0 },
        unsafeCSS: editorCSS,
        createEditor: (type, options, key) => new Editor(type, {
          ...options,
          roundedSelection: false,
          onAttach: (editor) => {
            const first = !this.editor;
            this.editor = editor;
            if (first) requestAnimationFrame(() => this.jumpTo(this.lineValue, this.columnValue));
          },
          onFocus: () => { this.showSource(); },
        }, key),
        onItemEditChange: (event) => this.edited(event),
      };
      this.viewer = new CodeView(this.options);
      this.viewer.setup(this.hostTarget);
      this.viewer.setItems([this.item()]);
      this.draft.listeners.add(this.renderDraft);
      this.renderDraft();
      if (this.draft.dirty && !this.draft.conflict) void this.save();
      this.copyButtonTarget.disabled = false;
      if (!file.writable) this.setStatus("Read only", "");
      this.jumpTo(this.lineValue, this.columnValue);
      if (this.hasRenderedMarkdownTarget && this.lineValue < 1) await this.showRenderedMarkdown();
    }

    private item(): CodeViewFileItem {
      return { id: this.pathValue, type: "file", file: { name: this.pathValue, contents: this.text }, edit: this.writable, version: ++this.version };
    }

    private edited(event: EditorChangeEvent<EditorType, undefined, undefined>): void {
      this.text = event.file.contents;
      if (this.applyingDisk) {
        this.invalidateMarkdownRender();
        return;
      }
      this.showSource();
      this.draft!.edit(editFileText(this.draft!.content, event.changes.map(({ start, end, text }) => ({ from: start, to: end, insert: text }))));
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => void this.save(), 500);
    }

    private readonly refreshRequested = (event: CustomEvent<EditorRefreshDetail>): void => {
      const detail = event.detail;
      if (detail.workspaceId !== this.workspaceIdValue) return;
      this.refreshDisk();
    };

    private readonly refreshDisk = (): void => {
      const { signal } = this.connection;
      void this.checkDisk(signal).catch((error: Error) => {
        if (this.isCurrentConnection(signal)) this.setStatus(`Refresh failed: ${error.message}`, "error");
      });
    };

    private async checkDisk(signal: AbortSignal): Promise<void> {
      if (!this.viewer) return;
      const sequence = ++this.diskSequence;
      const saveSequence = this.saveSequence;
      const revision = this.draft!.revision;
      const latest = await this.fetchFile(signal);
      if (!this.isCurrentConnection(signal) || sequence !== this.diskSequence || saveSequence !== this.saveSequence || revision !== this.draft!.revision) return;
      if (latest.revision === this.draft!.revision) {
        if (!this.draft!.dirty && !this.draft!.saving) this.setStatus(latest.writable ? "Up to date" : "Read only", "");
        return;
      }
      this.draft!.changedOnDisk(latest);
    }

    private save(force = false): Promise<void> {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.saveSequence++;
      return this.draft!.flush(force);
    }

    private readonly renderDraft = (): void => {
      if (!this.viewer || !this.isCurrentConnection(this.connection.signal)) return;
      const draft = this.draft!;
      const content = editorText(draft.content);
      if (this.text !== content) {
        this.replaceText(content);
        if (this.hasRenderedMarkdownTarget && !this.renderedMarkdownTarget.hidden) void this.showRenderedMarkdown();
      }
      this.copyButtonTarget.dataset.copyText = draft.content;
      if (draft.conflict) {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        this.conflictMineTarget.value = draft.content;
        this.conflictTheirsTarget.value = draft.conflict.content;
        this.setStatus("Conflict", "conflict");
        if (!this.conflictTarget.open) this.conflictTarget.showModal();
        return;
      }
      this.conflictTarget.close();
      const backupError = backupErrors.get(draft);
      if (draft.error) this.setStatus(`Not saved: ${draft.error}. Draft retained; edit or reopen to retry.`, "error");
      else if (backupError) this.setStatus(backupError, "error");
      else if (draft.dirty || draft.saving) this.setStatus("Saving…", "saving");
      else this.setStatus("Saved", "saved");
    };

    private replaceText(content: string): void {
      const previous = this.text;
      this.text = content;
      if (!this.editor) {
        this.viewer!.updateItem(this.item());
        return;
      }
      let start = 0;
      while (start < previous.length && start < content.length && previous[start] === content[start]) start++;
      let end = 0;
      while (end < previous.length - start && end < content.length - start && previous[previous.length - 1 - end] === content[content.length - 1 - end]) end++;
      const doc = this.editor.getEditState()!.document;
      this.applyingDisk = true;
      this.editor.applyEdits([{ range: { start: doc.positionAt(start), end: doc.positionAt(previous.length - end) }, newText: content.slice(start, content.length - end) }], false);
      this.applyingDisk = false;
    }

    private async fetchFile(signal: AbortSignal): Promise<EditableFileResponse> {
      const response = await fetch(this.contentUrlValue, { signal, headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error(await response.text());
      return parseEditableFileResponse(await response.json());
    }

    private async showRenderedMarkdown(): Promise<void> {
      const sequence = ++this.markdownRenderSequence;
      const { signal } = this.connection;
      this.setMarkdownRenderBusy(true);
      try {
        const renderMarkdownUrl = `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/files-view/render-markdown?${new URLSearchParams({ path: this.pathValue, filesView: this.filesViewValue })}`;
        const response = await fetch(renderMarkdownUrl, {
          method: "POST",
          signal,
          headers: { "content-type": "text/plain; charset=utf-8", "accept": "text/html" },
          body: this.text,
        });
        if (sequence !== this.markdownRenderSequence || !this.isCurrentConnection(signal)) return;
        if (!response.ok) throw new Error(await response.text());
        const html = await response.text();
        if (sequence !== this.markdownRenderSequence || !this.isCurrentConnection(signal)) return;
        this.renderedMarkdownTarget.innerHTML = html;
        this.setRenderedMarkdownVisible(true);
      } catch (error) {
        if (sequence !== this.markdownRenderSequence || !this.isCurrentConnection(signal)) return;
        this.setRenderedMarkdownVisible(false);
        this.setStatus("Unable to render", "error");
        throw error;
      } finally {
        if (sequence === this.markdownRenderSequence) this.setMarkdownRenderBusy(false);
      }
    }

    private showSource(): void {
      if (!this.hasRenderedMarkdownTarget) return;
      this.invalidateMarkdownRender();
      this.setRenderedMarkdownVisible(false);
    }

    private invalidateMarkdownRender(): void {
      if (!this.hasRenderedMarkdownTarget) return;
      this.markdownRenderSequence++;
      this.setMarkdownRenderBusy(false);
    }

    private setMarkdownRenderBusy(busy: boolean): void {
      this.markdownDisplayOptionsTarget.setAttribute("aria-busy", String(busy));
    }

    private setRenderedMarkdownVisible(visible: boolean): void {
      this.renderedMarkdownTarget.hidden = !visible;
      this.hostTarget.hidden = visible;
      setToggleValue(this.markdownDisplayOptionsTarget, visible ? "rendered" : "source");
    }

    positionRequestValueChanged(): void {
      this.jumpTo(this.lineValue, this.columnValue);
    }

    private jumpTo(line: number, column = 1): void {
      if (!this.viewer || line < 1) return;
      this.showSource();
      const lineNumber = Math.min(line, this.text.split("\n").length);
      if (this.editor) this.editor.focus({ lineNumber, character: Math.max(0, column - 1) });
      else this.viewer.scrollTo({ type: "line", id: this.pathValue, lineNumber, align: "center" });
    }

    private showLoadError(error: Error): void {
      this.loadingTarget.querySelector("span")!.textContent = error.message;
      this.loadingTarget.classList.add("is-error");
      this.setStatus("Unable to open", "error");
    }

    private setStatus(text: string, state: "" | "saving" | "saved" | "error" | "conflict"): void {
      this.statusTarget.textContent = text;
      this.statusTarget.className = `file-editor-status${state ? ` is-${state}` : ""}`;
    }
  };
}
