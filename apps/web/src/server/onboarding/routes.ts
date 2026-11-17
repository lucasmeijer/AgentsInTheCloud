import { finishOnboarding, onboardingCompleted } from "./state.ts";
import { actionLinkHtml } from "@agents-in-the-cloud/design-system/action-link";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { dialogHtml } from "@agents-in-the-cloud/design-system/dialog";
import { agentsInTheCloudBrandIconHtml, Icons } from "@agents-in-the-cloud/design-system/icons";
import type { GitHostingProvider } from "@agents-in-the-cloud/core";
import { escapeHtml, providerBadgeHtml, turboStreamResponse } from "@agents-in-the-cloud/shared";
import { connectedGitHostingProviders, gitHostingProvider, gitHostingProviders } from "@agents-in-the-cloud/git-hosting";
import { hasAvailableEnabledModel, renderModelsDialog } from "@agents-in-the-cloud/llm/server";
import { renderGitHostingConnectButton, renderGitHostingConnection } from "../settings/git-hosting.ts";
import { update } from "@agents-in-the-cloud/shared/http";

function progressHtml(step: number, steps: number): string {
  const items = Array.from({ length: steps }, (_, index) => `<span class="onboarding-progress-item"${index === step ? ' aria-current="step"' : ""}></span>`).join("");
  return `<div class="onboarding-progress" aria-label="Onboarding progress">${items}</div>`;
}

function onboardingDialogHtml(bodyHtml: string, footerHtml?: string): string {
  return dialogHtml({
    element: { id: "onboarding_dialog", attributesHtml: "data-dialog-auto-show" },
    iconHtml: agentsInTheCloudBrandIconHtml,
    titleCaption: "Set up AgentsInTheCloud",
    bodyHtml,
    bodyLayout: "full-bleed",
    footerHtml,
    omitCancelButton: true,
  });
}

function skipRowHtml(needsModelsStep: boolean): string {
  const content = { width: "fill", kind: "multiline", label: { kind: "text", text: "Somewhere else" }, leadingHtml: `<div class="settings-provider-icon onboarding-skip-icon">${Icons.Next}</div>` } as const;
  return needsModelsStep
    ? contentRowHtml({ ...content, element: { tag: "a", attributesHtml: 'href="/models?host=onboarding" data-turbo-stream="true"' } })
    : `<form method="post" action="/onboarding/finish" data-turbo="true">${contentRowHtml({ ...content, element: { tag: "button", attributesHtml: 'type="submit"' } })}</form>`;
}

function continueButtonHtml(needsModelsStep: boolean): string {
  const content = { kind: "caption", caption: "Continue" } as const;
  return needsModelsStep
    ? actionLinkHtml({ href: "/models?host=onboarding", variant: "secondary", content, attributesHtml: 'data-turbo-stream="true"' })
    : `<form method="post" action="/onboarding/finish" data-turbo="true">${buttonHtml({ type: "submit", variant: "secondary", content })}</form>`;
}

function chooseProviderHtml(needsModelsStep: boolean): string {
  const rows = gitHostingProviders.map((provider) => contentRowHtml({
    width: "fill",
    kind: "multiline",
    label: { kind: "text", text: provider.label },
    leadingHtml: providerBadgeHtml(provider.id, provider.label, "settings-provider-icon"),
    trailingHtml: provider.credential() ? "<span>Connected</span>" : undefined,
    element: { tag: "a", attributesHtml: `href="/onboarding?provider=${provider.id}" data-turbo-stream="true"` },
  })).join("");
  return onboardingDialogHtml(`${progressHtml(0, needsModelsStep ? 3 : 2)}
    <div class="onboarding-body form-stack"><h2 class="title">Where does your code live?</h2>
    <div class="onboarding-choices">${rows}${skipRowHtml(needsModelsStep)}</div></div>`);
}

function connectProviderHtml(provider: GitHostingProvider, needsModelsStep: boolean): string {
  const connected = Boolean(provider.credential());
  const back = actionLinkHtml({ href: "/onboarding", variant: "secondary", content: { kind: "caption", caption: "Back" }, attributesHtml: 'data-turbo-stream="true"' });
  return onboardingDialogHtml(
    `${progressHtml(1, needsModelsStep ? 3 : 2)}
    <div class="onboarding-body form-stack"><h2 class="title">Connect ${escapeHtml(provider.label)}</h2>${connected ? `<div class="managed-list" data-controller="managed-list">${renderGitHostingConnection("onboarding", provider)}</div>` : renderGitHostingConnection("onboarding", provider)}</div>`,
    `${back}${connected ? continueButtonHtml(needsModelsStep) : renderGitHostingConnectButton("onboarding", provider)}`,
  );
}

export async function renderOnboardingDialog(options: { includeCompleted?: boolean; resumeAfterConnect?: boolean; provider?: GitHostingProvider } = {}): Promise<string> {
  if (options.resumeAfterConnect) return renderModelsDialog({ host: "onboarding" });
  if (!options.includeCompleted && await onboardingCompleted()) return "";
  const modelsReady = await hasAvailableEnabledModel();
  if (!options.includeCompleted && connectedGitHostingProviders().length > 0) return modelsReady ? "" : renderModelsDialog({ host: "onboarding" });

  const needsModelsStep = options.includeCompleted || !modelsReady;
  return options.provider ? connectProviderHtml(options.provider, needsModelsStep) : chooseProviderHtml(needsModelsStep);
}

export async function handleOnboardingRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/onboarding/finish" && request.method === "POST") return finishOnboarding();
  if (url.pathname === "/onboarding" && request.method === "GET") {
    const providerId = url.searchParams.get("provider");
    const html = await renderOnboardingDialog({ includeCompleted: true, provider: providerId ? gitHostingProvider(providerId) : undefined });
    const acceptsStream = request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
    if (acceptsStream) return turboStreamResponse(update("onboarding_modal_host", html));
    return Response.redirect(new URL("/", url).toString(), 303);
  }
  return undefined;
}
