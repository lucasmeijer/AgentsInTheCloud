import { launchComposerCommand, recentWorkspaceTemplateStorageKey, type WorkspaceClientHooks } from "@agents-in-the-cloud/shared";

export function registerLaunchComposerCommand(hooks: WorkspaceClientHooks): void {
  hooks.registerCommand({
    ...launchComposerCommand,
    scope: "global",
    run() {
      const selectedWorkspace = document.querySelector<HTMLElement>('[data-workspace-entry-id][aria-current="page"]');
      const workspaceTemplateId = selectedWorkspace
        ? selectedWorkspace.dataset.workspaceTemplateId
        : localStorage.getItem(recentWorkspaceTemplateStorageKey);
      const frame = document.getElementById("launch_composer")!;
      frame.replaceChildren();
      frame.removeAttribute("src");
      frame.setAttribute("src", workspaceTemplateId ? `/launch-composer?workspaceTemplate=${encodeURIComponent(workspaceTemplateId)}` : "/launch-composer");
    },
  });
}
