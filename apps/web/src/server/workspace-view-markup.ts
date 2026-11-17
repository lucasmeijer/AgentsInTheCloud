import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { domId, escapeHtml, type LiveRegion } from "@agents-in-the-cloud/shared";
export interface ViewCloseAction {
  action: string;
  label: string;
}

/** Parts of the workspace chrome that change on their own, such as an Agent's title or busy
 * state. The chrome holds a permanent placeholder for each and publishes its content as a
 * child region, so a change resends only that part. */
export class LiveIslands {
  readonly regions: LiveRegion[] = [];

  island(target: string, html: string, tag = "span", className?: string): string {
    this.regions.push({ target, html });
    return `<${tag} id="${escapeHtml(target)}"${className ? ` class="${className}"` : ""} data-turbo-permanent></${tag}>`;
  }
}

export const paneSurfaceKinds = ["agent-pane", "work-view-body"] as const;
export type PaneSurfaceKind = typeof paneSurfaceKinds[number];

export function paneContentId(workspaceId: string, kind: PaneSurfaceKind, key: string): string {
  return domId(kind === "agent-pane" ? "agent_content" : "work_content", workspaceId, key);
}

export function paneContentHtml(workspaceId: string, kind: PaneSurfaceKind, key: string): string {
  return `<div class="fixed-shell-live-body" id="${escapeHtml(paneContentId(workspaceId, kind, key))}" data-turbo-permanent data-controller="live-surface" data-live-surface-workspace-value="${escapeHtml(workspaceId)}" data-live-surface-kind-value="${kind}" data-live-surface-key-value="${escapeHtml(key)}"></div>`;
}

export function barButton(label: string, action: string, iconHtml: string, attributes = ""): string {
  return buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml, label },
    attributesHtml: `data-action="${action}" ${attributes}`,
  });
}

export function busyAttentionIndicator(state: { busy?: boolean; requestingAttention?: boolean }): string {
  const label = [state.busy && "Busy", state.requestingAttention && "Requesting attention"].filter(Boolean).join("; ");
  return `<span class="status-indicator"${label ? ` role="img" aria-label="${label}"` : ""}>${state.busy ? '<i class="status-spinner sm" aria-hidden="true"></i>' : ""}${state.requestingAttention ? '<i class="status-dot attention" aria-hidden="true"></i>' : ""}</span>`;
}

export function fullscreenViewAttributes(key: string, title: string): string {
  return `data-controller="agents-in-the-cloud-fullscreen" data-agents-in-the-cloud-fullscreen-mode-value="view" data-agents-in-the-cloud-fullscreen-view-key-value="${escapeHtml(key)}" data-agents-in-the-cloud-fullscreen-title-value="${escapeHtml(title)}"`;
}

export function selectorCloseForm(close: ViewCloseAction): string {
  const label = `Close ${close.label}`;
  const confirmation = destructiveConfirmationHtml({
    id: `close_${close.action}`,
    trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Close, label } },
    confirmCaption: "Yes, close",
    cancelCaption: "Oops",
  });
  return `<form data-turbo="true" method="post" action="${escapeHtml(close.action)}">${confirmation}</form>`;
}

export function behaviorTurboStream(action: string, workspaceId: string, attributes: Record<string, string | number | boolean | undefined> = {}): string {
  let data = "";
  for (const [name, value] of Object.entries({ "workspace-id": workspaceId, ...attributes })) {
    if (value !== undefined) data += ` data-${name}="${escapeHtml(String(value))}"`;
  }
  return `<turbo-stream action="${escapeHtml(action)}" target="workspace_detail"${data}></turbo-stream>`;
}
