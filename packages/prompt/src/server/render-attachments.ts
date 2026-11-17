import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml, domId, formatBytes } from "@agents-in-the-cloud/shared";

export function renderAttachmentChip(attachment: { id: string; name: string; size: number; isImage: boolean }, draftId: string): string {
  const chipId = domId("agent_draft_chip", draftId, attachment.id);
  const previewUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachment.id)}`;
  const content = attachment.isImage
    ? buttonHtml({
      type: "button", variant: "secondary",
      content: { kind: "caption", caption: attachment.name, iconHtml: `<img class="agent-chip-thumbnail" src="${escapeHtml(previewUrl)}" alt="${escapeHtml(attachment.name)}">` },
      attributesHtml: `data-draft-image-preview aria-description="Open image preview" aria-haspopup="dialog" data-controller="agents-in-the-cloud-fullscreen" data-agents-in-the-cloud-fullscreen-mode-value="media" data-agents-in-the-cloud-fullscreen-title-value="${escapeHtml(attachment.name)}" data-action="agents-in-the-cloud-fullscreen#open"`,
    })
    : `<span class="agent-chip-ico">📄</span><span class="agent-chip-name">${escapeHtml(attachment.name)}</span>`;
  return `<span class="agent-chip" id="${chipId}">
    <input type="hidden" name="attachment" value="${escapeHtml(attachment.id)}">
    ${content}
    <span class="agent-chip-size">${formatBytes(attachment.size)}</span>
    ${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: `Remove ${attachment.name}` }, attributesHtml: `data-action="agent-attachments#remove" data-attachment-id="${escapeHtml(attachment.id)}"` })}
  </span>`;
}

export function renderAttachmentPicker(kind: "caption" | "icon-only" = "caption"): string {
  return `<input type="file" multiple hidden data-agent-attachments-target="file" data-action="change->agent-attachments#choose">
    ${buttonHtml({
      type: "button", variant: "secondary",
      content: kind === "caption"
        ? { kind, caption: "Attach files", iconHtml: Icons.Paperclip }
        : { kind, label: "Attach files", iconHtml: Icons.Paperclip },
      attributesHtml: `data-popular-button="${kind === "caption" ? "touch" : ""}" data-action="agent-attachments#openPicker"`,
    })}`;
}
