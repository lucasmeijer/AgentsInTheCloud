/// <reference lib="dom" />

import { setToggleValue, type ToggleChangeEvent } from "@agents-in-the-cloud/design-system/toggle/client";
import { errorMessage, type WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { editFileText, editorText, type FileTextChange } from "../editable-text.ts";
import { FileDraft } from "../file-draft.ts";
import { parseEditableFileResponse, parseFileSaveResponse, type EditableFileResponse } from "../protocol.ts";
import { languageExtension } from "./editor-language.ts";

// Retain drafts and in-flight writes across Turbo frame replacements.
const drafts = new Map<string, FileDraft>();
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
      // Storage quotas and browser privacy settings must not prevent disk saves.
      backupErrors.set(draft, `Draft backup failed: ${errorMessage(error)}. Keep this tab open until saved.`);
    }
  });
  drafts.set(url, draft);
  draft.changedOnDisk(file);
  return draft;
}

const editorHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--editor-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--editor-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--editor-number)" },
  { tag: [tags.comment, tags.meta], color: "var(--editor-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.propertyName), tags.heading], color: "var(--editor-title)" },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: "var(--editor-variable)" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "var(--editor-type)" },
]);

type EditorRefreshDetail = { workspaceId: string };

export function createFileEditorController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FileEditorController extends Controller {
    static values = { workspaceId: String, path: String, contentUrl: String, line: Number, column: Number, positionRequest: String };
    static targets = ["host", "loading", "status", "conflict", "conflictMine", "conflictTheirs", "renderedMarkdown", "markdownDisplayOptions", "copyButton"];

    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly pathValue: string;
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
    declare readonly hasRenderedMarkdownTarget: boolean;

    private view?: EditorView;
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
      this.view?.destroy();
      this.view = undefined;
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

    useTheirs(): void {
      this.draft!.accept(this.draft!.conflict!);
    }

    private isCurrentConnection(signal: AbortSignal): boolean {
      // Disconnect aborts this connection's signal, even across reconnects.
      // DOM removal can precede Stimulus delivering disconnect().
      return !signal.aborted && this.element.isConnected;
    }

    private async load(signal: AbortSignal): Promise<void> {
      const [file, language] = await Promise.all([this.fetchFile(signal), languageExtension(this.pathValue)]);
      if (!this.isCurrentConnection(signal)) return;
      this.draft = fileDraft(this.contentUrlValue, file);
      this.loadingTarget.hidden = true;
      this.view = new EditorView({
        parent: this.hostTarget,
        state: EditorState.create({
          doc: editorText(this.draft.content),
          extensions: [
            EditorView.lineWrapping,
            history(),
            drawSelection(),
            highlightActiveLine(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            highlightSelectionMatches(),
            syntaxHighlighting(editorHighlightStyle),
            language,
            EditorState.readOnly.of(!file.writable),
            EditorView.editable.of(file.writable),
            EditorView.domEventHandlers({
              focus: () => { this.showSource(); },
            }),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              // A response belongs to the document and editing choice that requested it.
              if (this.applyingDisk) {
                this.invalidateMarkdownRender();
                return;
              }
              this.showSource();
              const changes: FileTextChange[] = [];
              update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
                changes.push({ from, to, insert: inserted.toString() });
              });
              this.draft!.edit(editFileText(this.draft!.content, changes));
              if (this.saveTimer) clearTimeout(this.saveTimer);
              this.saveTimer = setTimeout(() => void this.save(), 500);
            }),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
          ],
        }),
      });
      this.draft.listeners.add(this.renderDraft);
      this.renderDraft();
      if (this.draft.dirty && !this.draft.conflict) void this.save();
      this.copyButtonTarget.disabled = false;
      if (!file.writable) this.setStatus("Read only", "");
      this.jumpTo(this.lineValue, this.columnValue);
      if (this.hasRenderedMarkdownTarget && this.lineValue < 1) await this.showRenderedMarkdown();
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
      if (!this.view) return;
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
      if (!this.view || !this.isCurrentConnection(this.connection.signal)) return;
      const draft = this.draft!;
      const content = editorText(draft.content);
      if (this.view.state.doc.toString() !== content) {
        this.applyingDisk = true;
        this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: content } });
        this.applyingDisk = false;
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
        const renderMarkdownUrl = `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/files-view/render-markdown?${new URLSearchParams({ path: this.pathValue })}`;
        const response = await fetch(renderMarkdownUrl, {
          method: "POST",
          signal,
          headers: { "content-type": "text/plain; charset=utf-8", "accept": "text/html" },
          body: this.view!.state.doc.toString(),
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
      if (!this.view || line < 1) return;
      this.showSource();
      const targetLine = this.view.state.doc.line(Math.min(line, this.view.state.doc.lines));
      const position = Math.min(targetLine.to, targetLine.from + Math.max(0, column - 1));
      this.view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
      this.view.focus();
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
