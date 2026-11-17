import { isWorkspacePaneVisible, type WorkspaceClientController, type WorkspaceClientControllerConstructor, type WorkspaceClientModule } from "@agents-in-the-cloud/shared";
import { installFileEditorControllers } from "./editor-controllers.ts";
type UploadResult = { kind: "ok" | "conflict" | "error" | "cancelled"; message?: string };
type UploadTask = { file: File; loaded: number; xhr?: XMLHttpRequest };
type StimulusActionEvent<EventType extends Event, CurrentTarget extends EventTarget> = EventType & {
  readonly currentTarget: CurrentTarget;
};

function createFilesController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FilesController extends Controller {
    static values = { path: String, uploadUrl: String, workspaceId: String };
    static targets = ["progress", "status"];

    declare readonly element: HTMLElement;
    declare readonly pathValue: string;
    declare readonly uploadUrlValue: string;
    declare readonly workspaceIdValue: string;
    declare readonly progressTarget: HTMLElement;
    declare readonly statusTarget: HTMLElement;

    private dragDepth = 0;
    private tasks: UploadTask[] = [];
    private cancelled = false;

    disconnect(): void {
      this.abortUploads();
    }

    dragEnter(event: DragEvent): void {
      if (!this.hasFiles(event)) return;
      event.preventDefault();
      this.dragDepth += 1;
      this.element.classList.add("is-dragging");
    }

    dragOver(event: DragEvent): void {
      if (!this.hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    dragLeave(event: DragEvent): void {
      if (!this.hasFiles(event)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.element.classList.remove("is-dragging");
    }

    drop(event: DragEvent): void {
      if (!this.hasFiles(event)) return;
      event.preventDefault();
      this.clearDragState();
      void this.startUpload(event, this.pathValue);
    }

    folderDragEnter(event: StimulusActionEvent<DragEvent, HTMLElement>): void {
      if (!this.hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.add("is-drop-target");
    }

    folderDragOver(event: DragEvent): void {
      if (!this.hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    folderDragLeave(event: StimulusActionEvent<DragEvent, HTMLElement>): void {
      event.stopPropagation();
      const row = event.currentTarget;
      if (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget)) row.classList.remove("is-drop-target");
    }

    folderDrop(event: StimulusActionEvent<DragEvent, HTMLElement>): void {
      if (!this.hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const row = event.currentTarget;
      row.classList.remove("is-drop-target");
      this.clearDragState();
      void this.startUpload(event, row.dataset.filesDestination!);
    }

    refresh(): void {
      this.element.querySelector<HTMLFormElement>(".files-filter")!.requestSubmit();
    }

    diskChanged(event: CustomEvent<{ workspaceId: string }>): void {
      if (event.detail.workspaceId === this.workspaceIdValue) this.refresh();
    }

    preserveExpandedDirectories(event: FormDataEvent): void {
      for (const row of this.element.querySelectorAll<HTMLElement>('[data-kind="directory"][aria-expanded="true"]')) {
        event.formData.append("expanded", row.dataset.filesPath!);
      }
    }

    keydown(event: KeyboardEvent): void {
      const rows = [...this.element.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      if (rows.length === 0) return;
      const current = document.activeElement instanceof HTMLElement ? rows.indexOf(document.activeElement.closest<HTMLElement>('[role="treeitem"]')!) : -1;
      let next: number | undefined;
      if (event.key === "ArrowDown") next = Math.min(rows.length - 1, current + 1);
      else if (event.key === "ArrowUp") next = Math.max(0, current < 0 ? 0 : current - 1);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = rows.length - 1;
      else if (event.key === "Enter" && current >= 0 && rows[current] instanceof HTMLAnchorElement) rows[current].click();
      else return;
      event.preventDefault();
      if (next !== undefined) rows[next]!.focus();
    }

    cancel(): void {
      this.abortUploads();
      this.statusTarget.textContent = "Upload cancelled";
    }

    private async startUpload(event: DragEvent, destination: string): Promise<void> {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      const items = [...(event.dataTransfer?.items ?? [])];
      const hasDirectory = items.some((item) => {
        const entry = item.webkitGetAsEntry?.();
        return entry?.isDirectory;
      });
      if (hasDirectory || files.some((file) => file.webkitRelativePath.length > 0)) {
        window.alert("Folder uploads are not supported yet. Drop files instead.");
        return;
      }

      this.cancelled = false;
      this.tasks = files.map((file) => ({ file, loaded: 0 }));
      this.showProgress();
      const results = await Promise.all(this.tasks.map((task) => this.upload(task, destination, false)));
      if (this.cancelled) return;

      const conflicts = this.tasks.filter((_, index) => results[index]?.kind === "conflict");
      if (conflicts.length > 0 && window.confirm(`${conflicts.length} ${conflicts.length === 1 ? "file already exists" : "files already exist"}. Overwrite?`)) {
        for (const task of conflicts) task.loaded = 0;
        this.updateProgress();
        results.push(...await Promise.all(conflicts.map((task) => this.upload(task, destination, true))));
      }
      if (this.cancelled) return;
      const errors = results.filter((result) => result.kind === "error");
      if (errors.length > 0) {
        this.statusTarget.textContent = `${errors.length} ${errors.length === 1 ? "upload" : "uploads"} failed: ${errors[0]?.message ?? "Unknown error"}`;
        return;
      }
      this.element.querySelector<HTMLElement>(".files-upload-status")!.hidden = true;
      this.refresh();
    }

    private upload(task: UploadTask, destination: string, overwrite: boolean): Promise<UploadResult> {
      return new Promise((resolve) => {
        const url = new URL(this.uploadUrlValue, location.origin);
        url.searchParams.set("destination", destination);
        url.searchParams.set("name", task.file.name);
        if (overwrite) url.searchParams.set("overwrite", "1");
        const xhr = new XMLHttpRequest();
        task.xhr = xhr;
        xhr.open("POST", url);
        xhr.setRequestHeader("content-type", task.file.type || "application/octet-stream");
        xhr.upload.addEventListener("progress", (progress) => {
          task.loaded = progress.loaded;
          this.updateProgress();
        });
        xhr.addEventListener("load", () => {
          task.loaded = task.file.size;
          this.updateProgress();
          if (xhr.status >= 200 && xhr.status < 300) resolve({ kind: "ok" });
          else if (xhr.status === 409) resolve({ kind: "conflict" });
          else resolve({ kind: "error", message: xhr.responseText || `HTTP ${xhr.status}` });
        });
        xhr.addEventListener("error", () => resolve({ kind: "error", message: "Network error" }));
        xhr.addEventListener("abort", () => resolve({ kind: "cancelled" }));
        xhr.send(task.file);
      });
    }

    private updateProgress(): void {
      const total = this.tasks.reduce((sum, task) => sum + task.file.size, 0);
      const loaded = this.tasks.reduce((sum, task) => sum + Math.min(task.loaded, task.file.size), 0);
      const percentage = total === 0 ? 100 : Math.round((loaded / total) * 100);
      this.progressTarget.style.width = `${percentage}%`;
      this.statusTarget.textContent = `Uploading ${this.tasks.length} ${this.tasks.length === 1 ? "file" : "files"} · ${percentage}%`;
    }

    private showProgress(): void {
      this.element.querySelector<HTMLElement>(".files-upload-status")!.hidden = false;
      this.updateProgress();
    }

    private abortUploads(): void {
      this.cancelled = true;
      for (const task of this.tasks) task.xhr?.abort();
    }

    private hasFiles(event: DragEvent): boolean {
      return [...(event.dataTransfer?.types ?? [])].includes("Files");
    }

    private clearDragState(): void {
      this.dragDepth = 0;
      this.element.classList.remove("is-dragging");
      for (const row of this.element.querySelectorAll(".is-drop-target")) row.classList.remove("is-drop-target");
    }
  };
}

interface FilesViewController extends WorkspaceClientController {
  focusFilter(): Promise<void>;
}

type FilesTreeFrame = HTMLElement & {
  loading: "eager" | "lazy";
  loaded: Promise<void>;
};

function createFilesViewController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FilesViewController extends Controller {
    static values = { selectedPath: String };
    declare readonly element: HTMLElement;
    declare readonly selectedPathValue: string;

    private pane!: HTMLElement;

    connect(): void {
      this.pane = this.element.closest<HTMLElement>("[data-workspace-pane-id]")!;
      this.pane.addEventListener("agents-in-the-cloud:workspace-pane-visible", this.becameVisible);
    }

    disconnect(): void {
      this.pane.removeEventListener("agents-in-the-cloud:workspace-pane-visible", this.becameVisible);
    }

    preservePaneState(event: Event & { detail: { attributeName: string } }): void {
      if (event.target === this.element && event.detail.attributeName === "class") event.preventDefault();
    }

    selectedPathValueChanged(): void {
      this.updateSelection();
      if (this.selectedPathValue) this.collapse();
    }

    updateSelection(): void {
      for (const row of this.element.querySelectorAll<HTMLElement>("[data-files-path]")) {
        if (row.dataset.filesPath === this.selectedPathValue) row.setAttribute("aria-selected", "true");
        else row.removeAttribute("aria-selected");
      }
    }

    private readonly becameVisible = (): void => { this.refresh(); };

    refresh(): void {
      this.element.querySelector<HTMLFormElement>(".files-filter")?.requestSubmit();
      this.element.querySelector<HTMLElement>('[data-controller="file-editor"]')?.dispatchEvent(new Event("agents-in-the-cloud:file-editor-refresh"));
    }

    expand(): void {
      this.element.classList.add("is-files-navigator-open");
      this.element.querySelector<FilesTreeFrame>(".files-frame")!.loading = "eager";
    }

    collapse(): void {
      this.element.classList.remove("is-files-navigator-open");
    }

    async focusFilter(): Promise<void> {
      this.expand();
      const frame = this.element.querySelector<FilesTreeFrame>(".files-frame")!;
      await frame.loaded;
      this.element.querySelector<HTMLInputElement>(".files-filter input[type='search']")!.focus();
    }
  };
}

const filesClientModule: WorkspaceClientModule = {
  id: "files",
  install({ application, Controller, hooks }) {
    application.register("files", createFilesController(Controller));
    application.register("files-view", createFilesViewController(Controller));
    installFileEditorControllers(application, Controller);
    hooks.registerCommand({
      id: "files.focus-filter",
      label: "Filter files",
      description: "Open the Files navigator and focus its filter.",
      scope: "work-view",
      run: async () => {
        const workbench = [...document.querySelectorAll<HTMLElement>(".files-workbench")]
          .find((candidate) => isWorkspacePaneVisible(candidate));
        if (!workbench) return;
        // SAFETY: Files workbenches are rendered with the connected files-view controller.
        const controller = application.getControllerForElementAndIdentifier(workbench, "files-view") as FilesViewController;
        await controller.focusFilter();
      },
    });
  },
};

export { filesClientModule as agentsInTheCloudClientModule };
