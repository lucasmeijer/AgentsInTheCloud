import { actionLinkHtml } from "@agents-in-the-cloud/design-system/action-link";
import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml } from "@agents-in-the-cloud/shared";

interface TemplateChoice { id: string; title: string; swatchColor?: string }

export function workspaceTemplateSwatchColor(workspaceTemplateId: string): string {
  let hash = 0x811c9dc5;
  for (const char of workspaceTemplateId) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `oklch(${[0.62, 0.7, 0.78][Math.floor(hash / 360) % 3]} 0.15 ${hash % 360})`;
}

export function workspaceTemplateIconHtml(workspaceTemplate?: Pick<TemplateChoice, "id" | "swatchColor">): string {
  return workspaceTemplate
    ? `<span class="workspace-template-icon" style="--workspace-template-swatch: ${escapeHtml(workspaceTemplate.swatchColor ?? workspaceTemplateSwatchColor(workspaceTemplate.id))}" aria-hidden="true"></span>`
    : '<span class="workspace-template-icon is-empty" aria-hidden="true"></span>';
}

export function workspaceTemplateChoiceHtml(template: TemplateChoice | undefined, options: {
  emptyLabel: string;
  primaryAttributesHtml: string;
  settingsAttributesHtml?: string;
}): string {
  const title = template?.title ?? options.emptyLabel;
  return contentRowHtml({
    kind: "compact", width: "fill",
    label: { kind: "text", text: title },
    leadingHtml: workspaceTemplateIconHtml(template),
    primary: { tag: "button", attributesHtml: options.primaryAttributesHtml },
    engagedActionsHtml: template ? actionLinkHtml({
      href: `/workspace-templates/${encodeURIComponent(template.id)}/settings`,
      variant: "secondary",
      content: { kind: "icon-only", iconHtml: Icons.More, label: `${title} settings` },
      attributesHtml: `data-turbo-frame="_top" data-turbo-stream="true" ${options.settingsAttributesHtml ?? ""}`,
    }) : undefined,
  });
}
