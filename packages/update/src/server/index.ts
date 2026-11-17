import { dialogHtml } from "@agents-in-the-cloud/design-system/dialog";
import { renderMarkdown } from "@agents-in-the-cloud/markdown";
import { fetchReleaseHistory } from "./release-history.ts";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { progressButtonHtml } from "@agents-in-the-cloud/design-system/progress-button";
import { toggleHtml } from "@agents-in-the-cloud/design-system/toggle";
import { transientFeedbackHtml } from "@agents-in-the-cloud/design-system/transient-feedback";
import { copyButtonHtml } from "@agents-in-the-cloud/design-system/copy-button";
import { warningBannerHtml } from "@agents-in-the-cloud/design-system/warning-banner";
import { requiredSystemVersion } from "@agents-in-the-cloud/shared/system-version";
import { errorMessage, escapeHtml, turboStream, turboStreamResponse, type SettingsContribution, type WorkspaceModule, type WorkspaceServerModuleContext } from "@agents-in-the-cloud/shared";
import { isUpdateChannel, type UpdateChannel } from "./update-channel.ts";
import { detectSelfUpdateRuntime, prepareUpdate, type PreparedUpdate, type PullProgress, type SelfUpdateRuntime } from "./docker.ts";
import { fetchChannelImageMetadata, type ImageMetadata } from "./registry.ts";
import { appRepository } from "@agents-in-the-cloud/shared/publishing";
import { readStoredUpdateChannel, writeStoredRepositories, writeStoredUpdateChannel } from "./settings-store.ts";
import { readSystemVersion, requestSupervisorUpdate } from "./supervisor.ts";

const updateSidebarContributionId = "agents-in-the-cloud-update";
const pollIntervalMs = 5 * 60 * 1000;

type UpdateState = "idle" | "checking" | "available" | "installer_required" | "pulling" | "ready_to_restart" | "failed" | "restarting";

const installerCommand = "curl -fsSL https://agentsinthecloud.com/install.sh | bash";

interface StateSnapshot {
  state: UpdateState;
  percent?: number;
  error?: string;
  selfUpdatable: boolean;
  target?: ImageMetadata;
  updateChannel: UpdateChannel;
  progressMessage?: string;
  systemOutdated: boolean;
  targetNeedsInstaller: boolean;
}

export interface UpdateManagerDeps {
  fetchReleaseHistory?: typeof fetchReleaseHistory;
  readChannel?: () => Promise<UpdateChannel | undefined>;
  writeChannel?: (channel: UpdateChannel) => Promise<void>;
  writeRepositories?: () => Promise<void>;
  detectRuntime?: () => Promise<SelfUpdateRuntime | undefined>;
  fetchMetadata?: (channel: UpdateChannel) => Promise<ImageMetadata>;
  prepareUpdate?: (reference: string, onProgress: (progress: PullProgress) => void) => Promise<PreparedUpdate>;
  requestUpdate?: (imageId: string) => Promise<void>;
  readSystemVersion?: () => Promise<number>;
  setInterval?: (handler: () => void, interval: number) => void;
}

class UpdateConflictError extends Error {}

export class UpdateManager {
  private context: WorkspaceServerModuleContext | undefined;
  private runtime: SelfUpdateRuntime | undefined;
  private systemVersion: number | undefined;
  private state: UpdateState = "idle";
  private percent: number | undefined;
  private error: string | undefined;
  private target: ImageMetadata | undefined;
  private updateChannel: UpdateChannel = "latest";
  private pullPromise: Promise<void> | undefined;
  private prepared: PreparedUpdate | undefined;
  private progressMessage: string | undefined;
  private restarting = false;
  private switchingChannel = false;
  private channelGeneration = 0;

  constructor(private readonly deps: UpdateManagerDeps = {}) {}

  async initialize(context: WorkspaceServerModuleContext): Promise<void> {
    this.context = context;
    this.runtime = await (this.deps.detectRuntime ?? detectSelfUpdateRuntime)();
    this.updateChannel = await this.deps.readChannel?.() ?? "latest";
    if (this.runtime) this.systemVersion = await (this.deps.readSystemVersion ?? readSystemVersion)();
    this.updateSidebar();
    if (!this.runtime) return;
    await this.deps.writeRepositories?.();
    await this.checkNow().catch((error) => console.error("Update check failed", error));
    const checkForUpdate = () => void this.checkNow().catch((error) => console.error("Update check failed", error));
    if (this.deps.setInterval) {
      this.deps.setInterval(checkForUpdate, pollIntervalMs);
    } else {
      const interval = setInterval(checkForUpdate, pollIntervalMs);
      interval.unref?.();
    }
  }

  snapshot(): StateSnapshot {
    const systemOutdated = this.systemVersion !== undefined && requiredSystemVersion > this.systemVersion;
    const targetNeedsInstaller = this.target !== undefined && this.systemVersion !== undefined && this.target.requiredSystemVersion > this.systemVersion;
    return { state: this.state, percent: this.percent, error: this.error, selfUpdatable: Boolean(this.runtime), target: this.target, updateChannel: this.updateChannel, progressMessage: this.progressMessage, systemOutdated, targetNeedsInstaller };
  }

  private updateSidebar(checked = false): void {
    const sidebarHtml = renderSidebarRow(this.snapshot());
    this.context?.globalSidebarContributions.set(updateSidebarContributionId, sidebarHtml || undefined, [
      { target: "settings-sec-update", html: renderUpdateSettings(this, checked), action: "replace" },
      { target: "settings-sec-update-channel", html: renderUpdateChannelSettings(this), action: "replace" },
    ]);
  }

  private setState(state: UpdateState, options: { percent?: number; error?: string } = {}, checked = false): void {
    this.state = state;
    this.percent = options.percent;
    this.error = options.error;
    this.updateSidebar(checked);
  }

  async checkNow(options: { announceCurrent?: boolean } = {}): Promise<void> {
    if (!this.runtime || this.switchingChannel || this.pullPromise || this.prepared || this.restarting) return;
    const generation = this.channelGeneration;
    const channel = this.updateChannel;
    if (this.state === "idle" || this.state === "failed") this.setState("checking");
    let target: ImageMetadata;
    try {
      target = await (this.deps.fetchMetadata ?? fetchChannelImageMetadata)(channel);
    } catch (error) {
      if (generation !== this.channelGeneration || this.pullPromise || this.prepared || this.restarting) return;
      this.setState("failed", { error: errorMessage(error) });
      throw error;
    }
    if (generation !== this.channelGeneration || this.pullPromise || this.prepared || this.restarting) return;
    const previous = this.target;
    this.target = target;
    const current = this.runtime.currentRevision ?? this.runtime.currentDigest;
    const remote = target.revision ?? target.digest;
    const available = Boolean(remote && current && remote !== current);
    if (!available) this.setState("idle", {}, options.announceCurrent ?? false);
    else if (this.state === "installer_required" && previous?.digest === target.digest) this.setState("installer_required");
    else this.setState("available");
  }

  async setUpdateChannel(channel: UpdateChannel): Promise<void> {
    if (!this.runtime) throw new Error("AgentsInTheCloud is not running in a System-managed installation");
    if (this.switchingChannel || this.pullPromise || this.restarting) throw new Error("Cannot switch update channels while an update is in progress");
    if (channel === this.updateChannel) return await this.checkNow();
    this.switchingChannel = true;
    try {
      await this.deps.writeChannel?.(channel);
      this.channelGeneration += 1;
      this.updateChannel = channel;
      this.target = undefined;
      this.prepared = undefined;
      this.setState("idle");
    } finally {
      this.switchingChannel = false;
    }
    await this.checkNow();
  }

  startPull(): Promise<void> {
    if (!this.runtime) throw new UpdateConflictError("AgentsInTheCloud is not running in a System-managed installation");
    if (this.switchingChannel) throw new UpdateConflictError("Update channel change is in progress");
    if (this.pullPromise) return this.pullPromise;
    if (!this.target || (this.state !== "available" && this.state !== "failed")) {
      throw new UpdateConflictError("No update is available to download. Check the selected channel first.");
    }
    if (this.snapshot().targetNeedsInstaller) {
      this.setState("installer_required");
      return Promise.resolve();
    }
    this.pullPromise = this.pullNewestTarget().catch((error) => {
      this.setState("failed", { error: errorMessage(error) });
    }).finally(() => {
      this.pullPromise = undefined;
    });
    return this.pullPromise;
  }

  private async pullNewestTarget(): Promise<void> {
    const reference = `${appRepository}@${this.target!.digest}`;
    this.prepared = undefined;
    this.setState("pulling");
    this.prepared = await (this.deps.prepareUpdate ?? prepareUpdate)(reference, (progress) => {
      this.percent = progress.percent;
      this.progressMessage = progress.message;
      this.updateSidebar();
    });
    this.progressMessage = undefined;
    this.setState("ready_to_restart", { percent: 100 });
  }

  async restart(): Promise<void> {
    if (!this.runtime) throw new UpdateConflictError("AgentsInTheCloud is not running in a System-managed installation");
    if (this.switchingChannel || this.restarting) throw new UpdateConflictError("An update is already in progress");
    if (this.state !== "ready_to_restart" || !this.prepared) throw new UpdateConflictError("No prepared update is ready to restart");
    this.restarting = true;
    this.setState("restarting");
    try {
      await (this.deps.requestUpdate ?? requestSupervisorUpdate)(this.prepared.imageId);
    } catch (error) {
      this.restarting = false;
      this.setState("ready_to_restart", { error: errorMessage(error) });
      throw error;
    }
  }

  async releaseHistory() {
    if (!this.runtime?.currentRevision || !this.target?.revision) throw new Error("This installation or update does not identify its code revision, so we can’t show the changes between them.");
    return await (this.deps.fetchReleaseHistory ?? fetchReleaseHistory)(this.runtime.currentRevision, this.target.revision);
  }

  dismissInstaller(): void {
    if (this.state === "installer_required") this.setState("available");
  }

  clearError(): void {
    this.error = undefined;
    this.updateSidebar();
  }
}

const manager = new UpdateManager({ readChannel: readStoredUpdateChannel, writeChannel: writeStoredUpdateChannel, writeRepositories: writeStoredRepositories });

function renderCheckButton(state: "initial" | "in-progress"): string {
  return progressButtonHtml({
    initialContent: { kind: "text", text: "Check now" },
    progressContent: { kind: "text", text: "Checking…" },
    state,
    variant: "secondary",
    type: "submit",
  });
}

function renderCheckForm(): string {
  return `<form method="post" action="/update/check-now" data-turbo="true">${renderCheckButton("initial")}</form>`;
}

function renderDownloadControl(snapshot: StateSnapshot): string {
  const content = {
    initialContent: { kind: "text" as const, text: snapshot.targetNeedsInstaller ? "Get update" : "Download update" },
    progressContent: { kind: "text" as const, text: "Downloading…" },
    variant: "primary" as const,
    type: "submit" as const,
  };
  if (snapshot.state === "pulling") return progressButtonHtml({ ...content, state: "in-progress", progress: snapshot.percent ?? 1 });
  const button = progressButtonHtml({ ...content, state: "initial" });
  return `<form method="post" action="/update/start" data-turbo="true">${button}</form>`;
}

type UpdateControlSurface = "settings" | "sidebar";

function restartFeedbackId(surface: UpdateControlSurface): string {
  return `update_restart_feedback_${surface}`;
}

function restartFormHtml(surface: UpdateControlSurface): string {
  const confirmation = destructiveConfirmationHtml({
    id: `restart_${surface}`,
    trigger: { type: "button", variant: "primary", content: { kind: "caption", caption: "Restart to update" } },
    confirmCaption: "Restart now",
    cancelCaption: "Cancel",
  });
  return `<form method="post" action="/update/restart?surface=${surface}" data-turbo="false" data-controller="update-restart" data-action="submit->update-restart#submit">${confirmation}<p role="alert" data-update-restart-target="error" hidden></p></form>`;
}

function renderRestartFeedback(surface: UpdateControlSurface, message?: string): string {
  return transientFeedbackHtml({
    element: { tag: "div",  attributesHtml: `id="${restartFeedbackId(surface)}"` },
    initialContent: { kind: "html", html: restartFormHtml(surface) },
    feedbackContent: { kind: "html", html: `<span class="transient-feedback__status update-restart-error">Could not restart: ${escapeHtml(message ?? "")}</span>` },
    state: message === undefined ? "initial" : "feedback",
  });
}

function renderCheckFeedback(state: "initial" | "in-progress", feedback = false): string {
  return transientFeedbackHtml({
    element: { tag: "div" },
    initialContent: { kind: "html", html: state === "initial" ? renderCheckForm() : renderCheckButton("in-progress") },
    feedbackContent: { kind: "html", html: '<span class="transient-feedback__status">You\'re up to date!</span>' },
    state: feedback ? "feedback" : "initial",
  });
}

function renderInstallerCopy(): string {
  return copyButtonHtml({ label: "Copy installer command", caption: "Copy installer command", copyText: installerCommand });
}

function renderSystemOutdated(snapshot: StateSnapshot): string {
  if (!snapshot.systemOutdated) return "";
  return warningBannerHtml({
    title: "Finish updating",
    message: "Some features won’t work until you run the installer again on the computer AgentsInTheCloud is installed on. Existing workspaces will survive but be interrupted.",
    actionsHtml: renderInstallerCopy(),
  });
}

function renderInstallerRequired(): string {
  return warningBannerHtml({
    message: "To get this version, run the installer again on the computer AgentsInTheCloud is installed on. Existing workspaces will survive but be interrupted.",
    actionsHtml: renderInstallerCopy(),
    dismiss: { action: "/update/dismiss-installer", state: "installer_required" },
  });
}

function renderUpdateControl(snapshot: StateSnapshot, surface: UpdateControlSurface): string {
  if (snapshot.state === "checking") return renderCheckFeedback("in-progress");
  if (!snapshot.selfUpdatable) return "";
  if ((snapshot.state === "failed" && !snapshot.target) || snapshot.state === "idle") return renderCheckFeedback("initial");
  if (snapshot.state === "available" || snapshot.state === "failed" || snapshot.state === "pulling") return renderDownloadControl(snapshot);
  if (snapshot.state === "ready_to_restart") return renderRestartFeedback(surface);
  return progressButtonHtml({
    initialContent: { kind: "text", text: "Restart to update" },
    progressContent: { kind: "text", text: "Restarting…" },
    state: "in-progress",
    variant: "primary",
  });
}

function updateDescription(snapshot: StateSnapshot): string {
  if (!snapshot.selfUpdatable) return "Updates require a System-managed installation.";
  switch (snapshot.state) {
    case "idle": return "Check for new updates.";
    case "checking": return "Checking for updates…";
    case "available": return "An update is available.";
    case "installer_required": return "";
    case "pulling": return "Downloading the update…";
    case "ready_to_restart": return "";
    case "restarting": return "";
    case "failed": return "The update needs attention.";
  }
}

function renderUpdateSettings(updateManager: UpdateManager, checked = false): string {
  const snapshot = updateManager.snapshot();
  const control = checked && snapshot.state === "idle" ? renderCheckFeedback("initial", true) : renderUpdateControl(snapshot, "settings");
  const description = updateDescription(snapshot);
  if (snapshot.state === "installer_required") return `<section class="settings-sec update-settings-control" id="settings-sec-update">${renderSystemOutdated(snapshot)}<div class="update-settings-summary"><h2>Updates</h2></div>${renderInstallerRequired()}</section>`;
  return `<section class="settings-sec update-settings-control" id="settings-sec-update">${renderSystemOutdated(snapshot)}<div class="update-settings-summary"><h2>Updates</h2>${description ? `<p class="settings-sub">${description}</p>` : ""}</div><div class="update-actions">${control}${renderNotesButton(snapshot, "settings")}</div>${renderError(snapshot)}<turbo-frame id="update_notes_settings"></turbo-frame></section>`;
}

function renderUpdateChannelSettings(updateManager: UpdateManager): string {
  const snapshot = updateManager.snapshot();
  const disabled = !snapshot.selfUpdatable || snapshot.state === "pulling" || snapshot.state === "restarting";
  const channel = toggleHtml({
    variant: "button",
    label: "Update channel",
    name: "channel",
    value: snapshot.updateChannel,
    form: { action: "/settings/update-channel" },
    options: [
      { value: "stable", label: "Stable", disabled },
      { value: "latest", label: "Latest", disabled },
    ],
  });
  return `<section class="settings-sec settings-choice-row" id="settings-sec-update-channel"><h2>Update channel</h2>${channel}</section>`;
}

function updateSettingsStream(updateManager: UpdateManager, checked = false): string {
  return turboStream("replace", "settings-sec-update", renderUpdateSettings(updateManager, checked), { method: "morph" });
}

const updateSettingsContribution: SettingsContribution = {
  id: "update",
  label: "Updates",
  order: 15,
  render: async () => renderUpdateSettings(manager),
};

const updateChannelSettingsContribution: SettingsContribution = {
  id: "update-channel",
  label: "Update channel",
  order: 14,
  render: async () => renderUpdateChannelSettings(manager),
};

function renderSidebarRow(snapshot: StateSnapshot): string {
  if (snapshot.systemOutdated) return `<section class="update-sidebar-section"><div id="update_sidebar_row" class="update-sidebar-row">${renderSystemOutdated(snapshot)}</div></section>`;
  if (!snapshot.selfUpdatable || snapshot.state === "idle" || snapshot.state === "checking") return "";
  if (snapshot.state === "installer_required") return `<section class="update-sidebar-section"><div id="update_sidebar_row" class="update-sidebar-row">${renderInstallerRequired()}</div></section>`;
  const description = updateDescription(snapshot);
  return `<section class="update-sidebar-section"><div id="update_sidebar_row" class="update-sidebar-row">${description ? `<p>${description}</p>` : ""}<div class="update-actions">${renderUpdateControl(snapshot, "sidebar")}${renderNotesButton(snapshot, "sidebar")}</div>${renderError(snapshot)}<turbo-frame id="update_notes_sidebar"></turbo-frame></div></section>`;
}

function renderNotesButton(snapshot: StateSnapshot, surface: UpdateControlSurface): string {
  if (!snapshot.target || snapshot.state === "idle" || snapshot.state === "checking") return "";
  return `<form method="get" action="/update/notes" data-turbo="true" data-turbo-frame="update_notes_${surface}"><input type="hidden" name="surface" value="${surface}">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "What’s new" } })}</form>`;
}

async function renderReleaseNotes(updateManager: UpdateManager): Promise<string> {
  const history = await updateManager.releaseHistory();
  const notes = history.releases.map(release => `<article><p class="settings-sub">${escapeHtml(release.id)} · ${escapeHtml(release.publishedAt.slice(0, 10))}</p><div class="markdown">${renderMarkdown("", release.notes)}</div></article>`).join("");
  const unfinished = !history.targetHasNotes ? "<p>This build also includes changes that haven’t been included in stable release notes yet.</p>" : "";
  return `${notes || "<p>No published stable release notes between these versions.</p>"}${unfinished}<p><a href="${escapeHtml(history.compareUrl)}" target="_blank" rel="noopener noreferrer">View changes on GitHub</a></p>`;
}

function renderError(snapshot: StateSnapshot): string {
  if (!snapshot.error) return "";
  const dismiss = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss update error" } });
  return `<div role="alert"><p>${escapeHtml(snapshot.error)}</p><form method="post" action="/update/dismiss-error" data-turbo="true">${dismiss}</form></div>`;
}

export function createUpdateRouteHandler(updateManager: UpdateManager): (request: Request, url: URL) => Promise<Response | undefined> {
  return async (request, url) => {
    if (url.pathname === "/update/notes" && request.method === "GET") {
      const surface = url.searchParams.get("surface");
      if (surface !== "settings" && surface !== "sidebar") return new Response("Missing update control surface", { status: 400 });
      let bodyHtml: string;
      try {
        bodyHtml = await renderReleaseNotes(updateManager);
      } catch (error) {
        console.error("Release notes failed", error);
        bodyHtml = `<p role="alert">${escapeHtml(errorMessage(error))}</p><p>You can still download the update. Try opening What’s new again in a moment.</p>`;
      }
      const dialog = dialogHtml({ element: { attributesHtml: 'data-dialog-auto-show' }, iconHtml: "", titleCaption: "What’s new", bodyHtml });
      return new Response(`<turbo-frame id="update_notes_${surface}">${dialog}</turbo-frame>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "POST" && (url.pathname.startsWith("/update/") || url.pathname === "/settings/update-channel") && !updateManager.snapshot().selfUpdatable) return new Response("Updates require AgentsInTheCloud System", { status: 409 });
    if (url.pathname === "/update/dismiss-installer" && request.method === "POST") {
      updateManager.dismissInstaller();
      return turboStreamResponse("");
    }
    if (url.pathname === "/update/dismiss-error" && request.method === "POST") {
      updateManager.clearError();
      return turboStreamResponse("");
    }
    if (url.pathname === "/settings/update-channel" && request.method === "POST") {
      const form = await request.formData();
      const channel = form.get("channel");
      if (!isUpdateChannel(channel)) return new Response("Unsupported update channel", { status: 400 });
      await updateManager.setUpdateChannel(channel);
      return turboStreamResponse("");
    }
    if (url.pathname === "/update/start" && request.method === "POST") {
      try {
        void updateManager.startPull();
      } catch (error) {
        if (!(error instanceof UpdateConflictError)) throw error;
        return turboStreamResponse(updateSettingsStream(updateManager), { status: 409 });
      }
      return turboStreamResponse("");
    }
    if (url.pathname === "/update/check-now" && request.method === "POST") {
      await updateManager.checkNow({ announceCurrent: true });
      return turboStreamResponse("");
    }
    if (url.pathname === "/update/restart" && request.method === "POST") {
      try {
        await updateManager.restart();
        return new Response(null, { status: 204, headers: { "x-agents-in-the-cloud-reload": "true" } });
      } catch (error) {
        const surface = url.searchParams.get("surface");
        if (surface !== "settings" && surface !== "sidebar") return new Response("Missing update control surface", { status: 400 });
        const message = errorMessage(error);
        return turboStreamResponse(turboStream("replace", restartFeedbackId(surface), renderRestartFeedback(surface, message)));
      }
    }
    return undefined;
  };
}

export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "agents-in-the-cloud-update",
  settingsContributions: [updateChannelSettingsContribution, updateSettingsContribution],
  staticFiles: {
    "/update-client.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  async initialize(context) {
    await manager.initialize(context);
  },
  routes: [{ handle: createUpdateRouteHandler(manager) }],
};
