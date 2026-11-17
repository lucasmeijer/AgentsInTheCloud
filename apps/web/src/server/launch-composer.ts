import { composerAttachmentAttributes, renderComposerBody } from "@agents-in-the-cloud/prompt/server";
import type { WorkspaceTemplateSummary } from "@agents-in-the-cloud/workspace-templates";
import { workspaceTemplateChoiceHtml, workspaceTemplateIconHtml } from "./workspace-template-presentation.ts";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { renderAgentTypePicker } from "./agent-type-picker.ts";
import { popupHtml } from "@agents-in-the-cloud/design-system/popup";
import { dictationComposerController } from "@agents-in-the-cloud/dictation/server";
import { domId, escapeHtml, type AgentLaunchFooterContext, type WorkspaceAgentType } from "@agents-in-the-cloud/shared";

export interface AgentLaunchPresentation {
  attributesHtml: string;
  formAttributesHtml: string;
  bodyHtml: string;
  footerHtml: string;
  discardUrl: string;
}
const launchAgentTypeFrameId = "launch_composer_agent_type";

export async function renderLaunchAgentType(agentType: WorkspaceAgentType, agentTypes: readonly WorkspaceAgentType[], context: AgentLaunchFooterContext): Promise<string> {
  if (context.readOnly) return `${buttonHtml({ type: "button", variant: "secondary", disabled: true,
    content: { kind: "caption", caption: agentType.label, iconHtml: agentType.iconHtml } })}${await agentType.launch.renderFooter(context)}`;
  const selectionFormId = `${launchAgentTypeFrameId}_selection`;
  const picker = popupHtml({
    id: `${launchAgentTypeFrameId}_menu`, label: "Agent type", placement: "above",
    trigger: { variant: "secondary", content: { kind: "caption", caption: agentType.label, iconHtml: agentType.iconHtml } },
    width: "content",
    contentHtml: renderAgentTypePicker(agentTypes, {
      attributes: item => `type="submit" name="agentTypeId" value="${escapeHtml(item.id)}" form="${selectionFormId}" role="menuitemradio" aria-checked="${item.id === agentType.id}"`,
    }),
  });
  return `<turbo-frame id="${launchAgentTypeFrameId}">
    <form id="${selectionFormId}" method="get" action="/launch-composer/agent-type" data-turbo-frame="${launchAgentTypeFrameId}" hidden></form>
    <input type="hidden" name="agentTypeId" value="${escapeHtml(agentType.id)}" form="${escapeHtml(context.formId)}">
    ${picker}
    ${await agentType.launch.renderFooter(context)}
  </turbo-frame>`;
}

export async function launchComposerContent(options: { draftId: string; agentType: WorkspaceAgentType; agentTypes: readonly WorkspaceAgentType[]; context: AgentLaunchFooterContext; workspaceTemplateId?: string; initialPrompt: string }): Promise<AgentLaunchPresentation> {
  const { draftId } = options;
  const rowId = domId("agent_draft_attach", draftId);
  return {
    attributesHtml: `data-controller="agent-attachments ${dictationComposerController}"${options.workspaceTemplateId ? ` data-dictation-composer-workspace-template-id-value="${escapeHtml(options.workspaceTemplateId)}"` : ""} ${composerAttachmentAttributes(draftId, rowId, "click->launch-composer-dialog#focusText")}`,
    formAttributesHtml: 'data-action="submit->dictation-composer#submit keydown->submit-shortcut#keydown submit->submit-shortcut#submit turbo:submit-end->launch-composer-dialog#submitted turbo:submit-end->submit-shortcut#submitted"',
    bodyHtml: renderComposerBody({
      draft: { id: draftId, rowId },
      inputHtml: `<textarea class="composer-input" name="text" placeholder="Describe what you want the agent to do… (optional)" aria-label="Initial agent prompt" data-action="paste->agent-attachments#paste">${escapeHtml(options.initialPrompt)}</textarea>`,
    }),
    footerHtml: await renderLaunchAgentType(options.agentType, options.agentTypes, options.context),
    discardUrl: `/agent-attachment-drafts/${encodeURIComponent(draftId)}/discard`,
  };
}

export function renderLaunchComposer(options: { action: string; formId: string; content: AgentLaunchPresentation }): string {
  const { content } = options;
  return `<div class="composer launch-composer" ${content.attributesHtml}>
    <div class="composer-surface">
      <form id="${escapeHtml(options.formId)}" method="post" action="${escapeHtml(options.action)}" data-turbo="true" ${content.formAttributesHtml}>
        ${content.bodyHtml}
      </form>
      <div class="composer-footer">${content.footerHtml}</div>
    </div>
  </div>`;
}

export function launchWorkspaceAction(workspaceTemplateId: string | undefined, autoSelect: boolean): string {
  const path = workspaceTemplateId ? `/workspace-template-agent-workspaces/${encodeURIComponent(workspaceTemplateId)}` : "/agent-workspaces";
  return `${path}${autoSelect ? "?autoSelect=true" : ""}`;
}

export function renderLaunchWorkspaceTemplate(workspaceTemplates: readonly WorkspaceTemplateSummary[], selected: WorkspaceTemplateSummary | undefined, autoSelect: boolean): string {
  const frameId = "launch_composer_workspace_template";
  const selectionFormId = `${frameId}_selection`;
  const ordered = [...workspaceTemplates].sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || left.name.localeCompare(right.name));
  return `<turbo-frame id="${frameId}" data-action="turbo:frame-load->launch-composer-dialog#templateChanged">
    <form id="${selectionFormId}" method="get" action="/launch-composer/workspace-template" data-turbo-frame="${frameId}" hidden>
      <input type="hidden" name="autoSelect" value="${autoSelect}">
    </form>
    <input type="hidden" data-launch-template-action="${escapeHtml(launchWorkspaceAction(selected?.id, autoSelect))}" value="${escapeHtml(selected?.id ?? "")}">
    ${popupHtml({
      id: `${frameId}_menu`, label: "Workspace template", width: "content",
      trigger: { variant: "secondary", content: { kind: "caption", caption: selected?.name ?? "Empty workspace", iconHtml: workspaceTemplateIconHtml(selected) } },
      contentHtml: [...ordered, undefined].map(template => workspaceTemplateChoiceHtml(template ? { ...template, title: template.name } : undefined, {
        emptyLabel: "Empty workspace",
        primaryAttributesHtml: `type="submit" name="workspaceTemplate" value="${escapeHtml(template?.id ?? "")}" form="${selectionFormId}" role="menuitemradio" aria-checked="${template?.id === selected?.id}"`,
        settingsAttributesHtml: 'data-action="click->dialog#close"',
      })).join(""),
    })}</turbo-frame>`;
}
