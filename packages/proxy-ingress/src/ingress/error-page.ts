import { disclosureHtml } from "@agents-in-the-cloud/design-system/disclosure";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { response } from "@agents-in-the-cloud/shared/http";
import { actionLinkHtml } from "@agents-in-the-cloud/design-system/action-link";
import { inlineDesignSystemCss } from "@agents-in-the-cloud/design-system/styles/server";
import { errorCategory, WorkspaceConnectionError, WorkspaceUpstreamError } from "./failure.ts";

let styles: Promise<string> | undefined;

export async function ingressErrorPage(error: Error, workspaceName: string): Promise<Response> {
  const category = errorCategory(error);
  const workspace = `workspace “${workspaceName}”`;
  let status = category === "connection_timeout" ? 504 : category === "connection_refused" ? 503 : 502;
  let title = "AgentsInTheCloud couldn’t load your app";
  let explanation = `AgentsInTheCloud couldn’t complete the request to ${workspace}. We couldn’t determine whether the failure was in AgentsInTheCloud or your app.`;
  let guidance = "Retry. If the problem continues, report it with the technical details below.";

  if (error instanceof WorkspaceUpstreamError) {
    const app = `Inside ${workspace}, the app on port ${error.port}`;
    if (category === "connection_refused") {
      title = "Your app isn’t accepting connections";
      explanation = `Inside ${workspace}, nothing is accepting connections on port ${error.port}.`;
      guidance = "Check that your server is running in this workspace. If it uses a different port, update the preview URL.";
    } else if (category === "connection_timeout") {
      title = "The connection to your app timed out";
      explanation = `${app} couldn’t complete the request in time.`;
      guidance = "Check the server process and app logs in this workspace for slow or stuck requests, then retry.";
    } else if (category === "tls_failure") {
      title = "A secure connection to your app failed";
      explanation = `${app} couldn’t establish an HTTPS connection.`;
      guidance = "Check the app’s HTTPS configuration and certificate. If it serves plain HTTP, use http:// in the preview URL.";
    } else if (category === "connection_closed") {
      title = "Your app closed the connection";
      explanation = `${app} closed the connection before returning a complete response.`;
      guidance = "Check its logs in this workspace for a crash, restart, or interrupted request.";
    } else if (category === "malformed_upstream") {
      title = "Your app didn’t return a valid HTTP response";
      explanation = `Inside ${workspace}, the service on port ${error.port} didn’t return a valid HTTP response.`;
      guidance = "Check that the preview points to your web server, not a database or another non-web service. Also check whether the server expects HTTP or HTTPS.";
    } else {
      title = "Your app couldn’t be reached inside the workspace";
      explanation = `AgentsInTheCloud reached ${workspace}, but couldn’t complete the connection to the app on port ${error.port}.`;
      guidance = "Check the server process, listening port, and app logs inside this workspace. Technical details below may help identify the cause.";
    }
  } else if (error instanceof WorkspaceConnectionError) {
    status = category === "connection_timeout" ? 504 : 503;
    title = "AgentsInTheCloud couldn’t reach your workspace";
    explanation = `AgentsInTheCloud couldn’t connect to ${workspace} to load your app. The request did not reach your app, so this error doesn’t indicate a problem with your code.`;
    guidance = "Try again shortly. If this continues, report an AgentsInTheCloud workspace connectivity problem to your administrator.";
  } else if (category === "workspace_authentication") {
    title = "AgentsInTheCloud couldn’t connect to your workspace";
    explanation = `AgentsInTheCloud’s connection credentials were rejected by ${workspace}. This is an AgentsInTheCloud connection problem, not your app’s login.`;
    guidance = "Report this problem to your AgentsInTheCloud administrator with the technical details below.";
  } else if (category === "unknown_app") {
    status = 404;
    title = "This preview link no longer points to an app";
    explanation = `The app for this preview is not registered in ${workspace}.`;
    guidance = "Open the workspace in AgentsInTheCloud and launch a new preview for the app you want to view.";
  } else if (category === "unknown_workspace") {
    status = 404;
    title = "This workspace could not be found";
    explanation = `AgentsInTheCloud couldn’t find ${workspace}. It may have been deleted.`;
    guidance = "Open the intended workspace in AgentsInTheCloud and use its preview link.";
  } else if (category === "stopped_workspace") {
    status = 503;
    title = "This workspace is stopped";
    explanation = `The app can’t be loaded because ${workspace} is stopped.`;
    guidance = "Start the workspace in AgentsInTheCloud, then retry the preview.";
  } else if (category === "ineligible_port") {
    status = 400;
    title = "This port can’t be used for a preview";
    explanation = `The requested port is not available for app previews in ${workspace}.`;
    guidance = "Choose the port your web server listens on. Ports must be between 1 and 65535; port 2999 is reserved for AgentsInTheCloud.";
  } else if (category === "capacity_exhausted") {
    status = 507;
    title = "AgentsInTheCloud can’t open another preview right now";
    explanation = `AgentsInTheCloud has no preview capacity available to open this app in ${workspace}.`;
    guidance = "Retry later or ask your AgentsInTheCloud administrator to check preview capacity. This is not a problem with your app’s code.";
  } else if (category === "unsupported_target") {
    status = 422;
    title = "This preview doesn’t support this connection";
    explanation = `The preview target in ${workspace} doesn’t support the requested connection type.`;
    guidance = "If your app needs WebSockets, open a preview connected directly to its running web server.";
  } else if (category === "service_stopping") {
    status = 503;
    title = "AgentsInTheCloud’s preview service is restarting or shutting down";
    explanation = `The preview for ${workspace} is temporarily unavailable. Your app may still be running.`;
    guidance = "Retry shortly.";
  } else if (category === "origin_conflict") {
    status = 503;
    title = "AgentsInTheCloud couldn’t open this preview address";
    explanation = `The address assigned to the preview for ${workspace} is already in use by another process in AgentsInTheCloud.`;
    guidance = "Ask your AgentsInTheCloud administrator to check the preview address conflict. This is not a conflict with your app’s listening port.";
  } else if (category === "protocol_conflict") {
    status = 400;
    title = "This port already has a preview using another protocol";
    explanation = `The requested HTTP or HTTPS protocol differs from the existing preview configuration in ${workspace}.`;
    guidance = "Use the existing preview, or update its configuration if the server’s protocol has changed.";
  }

  const css = await (styles ??= inlineDesignSystemCss());
  const retry = actionLinkHtml({ href: "", variant: "secondary", content: { kind: "caption", caption: "Retry" } });
  return response(`<!doctype html><html lang="en" data-theme="nord"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · AgentsInTheCloud</title><style>${css}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: var(--text-body)/var(--leading-standard) var(--font-sans);
}
main {
  max-width: 520px;
  margin: 0 auto;
  padding: clamp(40px, 12vh, 120px) 24px 40px;
  overflow-wrap: anywhere;
}
p { line-height: var(--leading-copy); margin: 16px 0; }
.actions { margin-top: 24px; }
details { margin-top: 32px; }
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: var(--text-code)/var(--leading-copy) var(--font-mono);
  margin-top: 16px;
}
</style></head><body><main><h1 class="title">${escapeHtml(title)}</h1><p>${escapeHtml(explanation)}</p><p>${escapeHtml(guidance)}</p><div class="actions">${retry}</div>${disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Technical details" } }, bodyHtml: `<pre>${escapeHtml(`Workspace: ${workspaceName}\n${error instanceof WorkspaceUpstreamError ? `Attempted address: 127.0.0.1:${error.port} inside this workspace\n` : ""}\n${error.message}`)}</pre>` })}</main></body></html>`, {
    status,
    headers: { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'", "x-content-type-options": "nosniff" },
  });
}
