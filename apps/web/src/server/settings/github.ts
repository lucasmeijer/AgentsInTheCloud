import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { clearGitHubToken, hasGitHubToken, setGitHubToken } from "@agents-in-the-cloud/proxy-egress";
import { getStoredCommitIdentity, setCommitIdentity } from "@agents-in-the-cloud/workspace-templates";
import { validateGitHubToken } from "../github-auth.ts";
import { renderOnboardingDialog } from "../onboarding/routes.ts";
import { replace, stream, update } from "@agents-in-the-cloud/shared/http";
import { renderCommitIdentityForm } from "./page.ts";
import { domId, escapeHtml, providerBadgeHtml } from "@agents-in-the-cloud/shared";
import { registerSettingsContribution } from "./registry.ts";

type SettingsSurface = "settings" | "onboarding";

const githubDisconnectConfirmation = destructiveConfirmationHtml({
  id: "disconnect_github",
  trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Disconnect" } },
  confirmCaption: "Disconnect GitHub",
  cancelCaption: "Cancel",
});

export function renderGitHubConnectButton(surface: SettingsSurface): string {
  return buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption: "Connect" },
    attributesHtml: `form="${domId(surface, "github-connect-form")}"`,
  });
}

function githubConnectionForm(surface: SettingsSurface, error: string): string {
  const action = surface === "onboarding" ? "/settings/github/connect?surface=onboarding" : "/settings/github/connect";
  const rowClass = surface === "settings" ? " github-connect-form--row" : "";
  const connectButton = surface === "onboarding" ? "" : renderGitHubConnectButton(surface);
  return `<form id="${domId(surface, "github-connect-form")}" class="github-connect-form${rowClass} form-stack" method="post" action="${action}" data-turbo="true">
    <p>Run these commands on your own computer:</p>
    <pre class="settings-command">gh auth login
gh auth token</pre>
    <p>Paste the token below. AgentsInTheCloud keeps it outside Agent sandboxes, so Agents can access your GitHub repositories without seeing the token.</p>
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    <div class="github-connect-controls"><input class="settings-input text-field" type="password" data-1p-ignore name="token" placeholder="Paste output from gh auth token" aria-label="GitHub token" autocomplete="off" required>${connectButton}</div>
  </form>`;
}

export function renderGitHubConnection(surface: SettingsSurface = "settings", error = ""): string {
  const connected = hasGitHubToken();
  const id = domId(surface, "provider", "github");
  const disconnectAction = surface === "onboarding" ? "/settings/github/disconnect?surface=onboarding" : "/settings/github/disconnect";
  if (surface === "onboarding" && !connected) return `<div class="github-connection" id="${id}">${githubConnectionForm(surface, error)}</div>`;
  return `<div class="github-connection" id="${id}"><div class="managed-list" data-controller="managed-list"><div class="managed-list__item">
    ${providerBadgeHtml("github", "GitHub", "settings-provider-icon managed-list__visual")}
    <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">GitHub</span></div>${connected ? "" : githubConnectionForm(surface, error)}</div>
    ${connected ? `<div class="managed-list__actions"><form method="post" action="${disconnectAction}" data-turbo="true">${githubDisconnectConfirmation}</form></div>` : ""}
  </div></div></div>`;
}

async function renderGitHubSettings(): Promise<string> {
  return `<section class="settings-sec settings-sec-github" id="settings-sec-github">${renderGitHubConnection()}</section>`;
}

registerSettingsContribution({ id: "github", label: "GitHub", order: 30, render: renderGitHubSettings });

export async function handleGitHubSettingsRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/settings/github/connect" && request.method === "POST") {
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    const form = await request.formData();
    const token = String(form.get("token") ?? "").trim();
    const validation = await validateGitHubToken(token);
    if (!validation.ok) return stream(replace(domId(surface, "provider", "github"), renderGitHubConnection(surface, validation.message)));
    setGitHubToken(token);
    if (!await getStoredCommitIdentity()) await setCommitIdentity({ name: validation.name, email: validation.email });
    return surface === "onboarding"
      ? stream(update("onboarding_modal_host", await renderOnboardingDialog({ resumeAfter: "github" })))
      : stream(`${replace("settings-sec-github", await renderGitHubSettings())}${replace("settings_commit_identity", await renderCommitIdentityForm())}${update("onboarding_modal_host", await renderOnboardingDialog())}`);
  }
  if (url.pathname === "/settings/github/disconnect" && request.method === "POST") {
    const surface = url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";
    clearGitHubToken();
    return surface === "onboarding"
      ? stream(update("onboarding_modal_host", await renderOnboardingDialog()))
      : stream(replace("settings-sec-github", await renderGitHubSettings()));
  }
  return undefined;
}
