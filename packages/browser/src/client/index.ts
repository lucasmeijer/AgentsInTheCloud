import type { WorkspaceClientControllerConstructor, WorkspaceClientModule } from "@agents-in-the-cloud/shared";

function createBrowserAddressController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class BrowserAddressController extends Controller {
    declare readonly element: HTMLFormElement;

    initializeAddress(): void {
      const input = this.input();
      if (input && !input.value) input.value = "http://localhost:3000";
    }

    submit(): void {
      const input = this.input();
      if (!input) return;
      input.value = normalizeBrowserInput(input.value);
    }

    reload(event?: Event): void {
      event?.preventDefault();
      const iframe = this.iframe();
      if (iframe?.src) iframe.src = iframe.src;
    }

    private input(): HTMLInputElement | null {
      return this.element.querySelector<HTMLInputElement>(".browser-address-input");
    }

    private iframe(): HTMLIFrameElement | null {
      return this.element.closest(".browser-shell")?.querySelector<HTMLIFrameElement>("iframe") ?? null;
    }
  };
}

function normalizeBrowserInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

const browserClientModule: WorkspaceClientModule = {
  id: "browser",
  install({ application, Controller }) {
    application.register("browser-address", createBrowserAddressController(Controller));

  },
};

export { browserClientModule as agentsInTheCloudClientModule };
