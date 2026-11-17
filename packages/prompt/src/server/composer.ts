import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { renderDictationComposerControl } from "@agents-in-the-cloud/dictation/server";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { renderAttachmentChip, renderAttachmentPicker } from "./render-attachments.ts";
import type { StagedAttachment } from "./attachment-drafts.ts";

export const agentComposerActions = "mousedown->composer-focus#preserveInputFocus agents-in-the-cloud:workspace-pane-visible@document->agent-composer#selected agents-in-the-cloud:workspace-pane-hidden@document->agent-composer#hidden agent-attachments:files->agent-composer#reveal agent-composer:sending->agent-composer#sending agent-composer:sent->agent-composer#sent agent-composer:failed->agent-composer#failed input->agent-composer#draftChanged focusin->agent-composer#focused click->agent-composer#focusText agents-in-the-cloud:software-keyboard@document->agent-composer#layout resize@window->agent-composer#autosize agent-composer:resize->agent-composer#autosize agent-composer:quote->agent-composer#quote";

const sendIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg>';

/**
 * The shared form body; each host owns its form, supplementary UI, and optional footer.
 * Buttons form one column on the right, top to bottom: close (collapsible composers only), attach, dictate, send.
 * Prompt template buttons wrap under the text field, beside the buttons.
 */
export function renderComposerBody(options: {
  draft: { id: string; rowId: string; attachments?: readonly StagedAttachment[] };
  inputHtml: string;
  sendHtml?: string;
  collapsible?: boolean;
  promptTemplateButtons?: boolean;
}): string {
  const { draft } = options;
  const send = options.sendHtml ?? buttonHtml({ type: "submit", variant: "primary", content: { kind: "icon-only", iconHtml: sendIcon, label: "Send prompt" }, attributesHtml: "data-popular-button" });
  const close = options.collapsible
    ? `<span class="composer-button composer-close">${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Close composer" }, attributesHtml: 'data-popular-button data-action="agent-composer#close"' })}</span>`
    : "";
  return `<input type="hidden" name="attachmentDraft" value="${escapeHtml(draft.id)}">
    <div class="agent-attach-row" id="${escapeHtml(draft.rowId)}" data-agent-attachments-target="row">${(draft.attachments ?? []).map((attachment) => renderAttachmentChip(attachment, draft.id)).join("")}</div>
    <div class="composer-input-area">${options.inputHtml}${options.promptTemplateButtons ? '<div class="composer-prompt-template-buttons" data-agent-completions-target="promptTemplateButtons"></div>' : ""}<div class="composer-buttons">
      ${close}
      <span class="composer-button composer-attach">${renderAttachmentPicker("icon-only")}</span>
      <span class="composer-button composer-dictation">${renderDictationComposerControl()}</span>
      <span class="composer-button composer-send">${send}</span>
    </div></div>
    <p role="status" data-agent-attachments-target="status" hidden></p>`;
}

/**
 * The floating stack: buttons overlaid at the bottom right of a transcript or terminal.
 * Each slot is filled by its owner; the order is fixed, bottom to top: open composer
 * (the composer), view switch (the CLI agent), follow latest (the showing transcript).
 * A hidden button leaves no gap.
 */
export function renderFloatingStack(slots: { openComposer?: string; viewSwitch?: string; followLatest?: string }): string {
  return `<div class="floating-stack">${slots.followLatest ?? ""}${slots.viewSwitch ?? ""}${slots.openComposer ?? ""}</div>`;
}

export function renderFollowLatestButton(attributesHtml: string): string {
  return buttonHtml({
    type: "button", variant: "secondary",
    content: { kind: "icon-only", iconHtml: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16h12M10 4v9m-4-4 4 4 4-4"/></svg>', label: "Follow latest" },
    attributesHtml: `data-popular-button ${attributesHtml} hidden`,
  });
}

export function renderOpenComposerButton(): string {
  const button = buttonHtml({
    type: "button", variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Keyboard, label: "Open composer" },
    attributesHtml: 'data-popular-button data-agent-composer-target="opener" data-action="click->agent-composer#open pointerdown->agent-composer#pressOpener pointerup->agent-composer#releaseOpener pointercancel->agent-composer#releaseOpener pointerleave->agent-composer#releaseOpener contextmenu->agent-composer#suppressContextMenu" aria-description="Hold to dictate"',
  });
  return `<div class="agent-composer-opener">${button}<span class="status-dot attention agent-composer-draft-dot" aria-hidden="true"></span></div>`;
}

export function composerAttachmentAttributes(draftId: string, rowId: string, actions = ""): string {
  const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(rowId)}`;
  return `data-agent-attachments-upload-url-value="${escapeHtml(uploadUrl)}" data-action="${actions} dragover->agent-attachments#dragOver dragleave->agent-attachments#dragLeave drop->agent-attachments#drop"`;
}
