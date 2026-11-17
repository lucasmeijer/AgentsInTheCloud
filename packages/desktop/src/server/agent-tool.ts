import type { WorkspacePresenterDefinition } from "@agents-in-the-cloud/agent/server/tools";
import type { RunningDesktop } from "./runtime.ts";

export function createDesktopPresenter(deps: {
  startDesktop(): Promise<RunningDesktop>;
  presentDesktop(): Promise<void>;
}): WorkspacePresenterDefinition<{ kind: "desktop" }> {
  return {
    kind: "desktop",
    description: "Start or reuse the workspace's visible Chromium on an 800×900 Xvfb desktop and open its Desktop view. Returns a workspace-local cdpUrl for Playwright chromium.connectOverCDP, plus display and xauthority for X clients. Reuse the existing browser context; do not launch or close the shared browser. Headless Playwright remains independent.",
    parameters: {},
    async execute() {
      const desktop = await deps.startDesktop();
      await deps.presentDesktop();
      const details = { ...desktop, workView: { type: "desktop" } };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
}
