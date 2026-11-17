import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { domId, escapeHtml } from "@agents-in-the-cloud/shared";
import { agentPath, type AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import { currentNotificationTurn } from "./turn-notifications.ts";

export function notificationControlId(ctx: AgentRenderContext): string { return domId("agent_notification", ctx.workspaceId, ctx.agentId); }
export function notificationFrameId(ctx: AgentRenderContext): string { return `${notificationControlId(ctx)}_frame`; }
export function notificationFeedbackId(workspaceId: string, agentId: string): string { return domId("agent_notification_feedback", workspaceId, agentId); }

export function renderAgentNotifications(ctx: AgentRenderContext): string {
  return `<span data-controller="agent-notifications">${renderNotificationFeedback(ctx.workspaceId, ctx.agentId)}${renderNotificationControl(ctx, false)}</span>`;
}

export function renderNotificationFeedback(workspaceId: string, agentId: string, message = "", error = false): string {
  return `<span id="${notificationFeedbackId(workspaceId, agentId)}" class="agent-noticeline agent-notification-feedback"${message ? "" : " hidden"} data-agent-notifications-target="feedback"><span role="${error ? "alert" : "status"}" data-agent-notifications-target="message">${escapeHtml(message)}</span>${buttonHtml({
    type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss notification message" },
    attributesHtml: 'data-action="click->agent-notifications#dismiss"',
  })}</span>`;
}

export function renderNotificationControl(ctx: AgentRenderContext, busy: boolean): string {
  if (!busy) return `<span id="${notificationControlId(ctx)}" hidden></span>`;
  const turn = currentNotificationTurn(ctx);
  const armed = turn?.armed ?? false;
  const label = armed ? "Cancel notification for this turn" : "Notify when this turn finishes";
  return `<span id="${notificationControlId(ctx)}" hidden>${buttonHtml({
    type: "button", variant: armed ? "primary" : "secondary", disabled: !turn,
    content: { kind: "icon-only", iconHtml: Icons.Bell, label },
    attributesHtml: `aria-pressed="${armed}" data-action="click->agent-notifications#toggle" data-notification-url="${escapeHtml(agentPath(ctx, "/notification"))}" data-notification-turn="${turn?.id ?? ""}" data-notification-armed="${armed}"`,
  })}</span>`;
}
