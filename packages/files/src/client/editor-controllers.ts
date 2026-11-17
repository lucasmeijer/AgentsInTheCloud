import { isWorkspacePaneVisible, type WorkspaceClientApplication, type WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";
type EditorRefreshDetail = { workspaceId: string };

function createFileEditorNavigationController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FileEditorNavigationController extends Controller {
    static values = { editor: String, request: String, line: Number, column: Number };
    declare readonly editorValue: string;
    declare readonly requestValue: string;
    declare readonly lineValue: number;
    declare readonly columnValue: number;
    requestValueChanged(): void {
      queueMicrotask(() => {
        const editor = document.getElementById(this.editorValue);
        if (!editor) return;
        editor.dataset.fileEditorLineValue = String(this.lineValue);
        editor.dataset.fileEditorColumnValue = String(this.columnValue);
        editor.dataset.fileEditorPositionRequestValue = this.requestValue;
      });
    }
  };
}

function createFilesRefreshSignalController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FilesRefreshSignalController extends Controller {
    static values = { workspaceId: String, generation: Number };
    declare readonly workspaceIdValue: string;
    generationValueChanged(): void {
      window.dispatchEvent(new CustomEvent<EditorRefreshDetail>("agents-in-the-cloud:files-refresh", { detail: { workspaceId: this.workspaceIdValue } }));
    }
  };
}

export function installFileEditorControllers(application: WorkspaceClientApplication, Controller: WorkspaceClientControllerConstructor): void {
  application.register("file-editor-navigation", createFileEditorNavigationController(Controller));
  let loading: Promise<void> | undefined;
  application.register("file-editor", class extends Controller {
    connect(): void {
      document.addEventListener("agents-in-the-cloud:workspace-pane-visible", this.activate);
      this.activate();
    }
    disconnect(): void { document.removeEventListener("agents-in-the-cloud:workspace-pane-visible", this.activate); }
    private readonly activate = (): void => {
      if (!isWorkspacePaneVisible(this.element)) return;
      loading ??= import("./file-editor.ts").then(({ createFileEditorController }) => {
        application.register("file-editor", createFileEditorController(Controller));
      });
    };
  });
  application.register("files-refresh-signal", createFilesRefreshSignalController(Controller));
}
