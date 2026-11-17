import { registerLiveSurfaces } from "./live-surface.ts";

import { Application as StimulusApplication, Controller as StimulusController } from "@hotwired/stimulus";
import { registerDesignSystemControllers } from "@agents-in-the-cloud/design-system/client";
import {
  installSoftwareKeyboardTracking,
  type AgentsInTheCloudCableClient,
  type WorkspaceClientControllerConstructor,
} from "@agents-in-the-cloud/shared";
import { createProvisionTerminalController } from "@agents-in-the-cloud/workspace/client";
// @ts-expect-error Turbo ships no TypeScript declarations.
import * as Turbo from "@hotwired/turbo";
import { NavigationOriginController } from "./navigation-origin-controller.ts";
import { ConnectionModeSettingsController } from "./connection-mode-settings.ts";
import { PwaReminderController } from "./pwa-reminder.ts";
import { registerWorkspaceAppFrameController } from "./workspace-app-frame.ts";
import { installWorkspaceCable } from "./workspace-cable.ts";
import { clientHooks } from "./workspace-client-hooks.ts";
import { workspaceClientModules } from "./workspace-client-modules.generated.ts";
import { initializeWorkspaceControllerRegistry, registerWorkspaceControllers, workspaceNavigationController } from "./workspace-controller-registry.ts";
import { registerWorkspaceDevReloadController } from "./workspace-dev-reload.ts";
import { registerWorkspaceDialogControllers } from "./workspace-dialogs.ts";
import { registerWorkspaceFullscreenController } from "./workspace-fullscreen.ts";
import { registerWorkspaceNavigationControllers } from "./workspace-navigation.ts";
import { createWorkspacePresentationController, installWorkspacePresentationTurboStream } from "./workspace-presentation.ts";
import { registerWorkspaceSelectionController } from "./workspace-selection.ts";
import { registerWorkspaceSettingsControllers } from "./workspace-settings.ts";
import { registerWorkspaceShortcutsController } from "./workspace-shortcuts.ts";

declare global {
  interface Window {
    Turbo?: { renderStreamMessage(html: string): void };
    AgentsInTheCloudCable?: AgentsInTheCloudCableClient;
  }
}

window.Turbo = Turbo;

const Controller: WorkspaceClientControllerConstructor = StimulusController;
const application = StimulusApplication.start();
application.register("navigation-origin", NavigationOriginController);
installSoftwareKeyboardTracking();
initializeWorkspaceControllerRegistry(application);

installWorkspaceCable();
registerLiveSurfaces();
installWorkspacePresentationTurboStream(Turbo, application);
Turbo.StreamActions["select-workspace"] = function selectWorkspace(this: HTMLElement): void {
  const workspaceId = this.dataset.workspaceId;
  if (!workspaceId) throw new Error("select-workspace requires a Workspace id");
  void workspaceNavigationController()?.selectWorkspaceById(workspaceId);
};

for (const module of workspaceClientModules) await module.install({ application, Controller, hooks: clientHooks });
registerWorkspaceControllers({
  "connection-mode-settings": ConnectionModeSettingsController,
  "pwa-reminder": PwaReminderController,
  "workspace-presentation": createWorkspacePresentationController(Controller, application, clientHooks),
});
registerWorkspaceNavigationControllers();
registerWorkspaceSelectionController();
registerWorkspaceShortcutsController();
registerWorkspaceFullscreenController();
registerWorkspaceDialogControllers();
registerWorkspaceAppFrameController();
registerWorkspaceSettingsControllers();
registerWorkspaceDevReloadController();
registerDesignSystemControllers(application);
registerWorkspaceControllers({
  "provision-terminal": createProvisionTerminalController(Controller),
});

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/service-worker.js");
}
