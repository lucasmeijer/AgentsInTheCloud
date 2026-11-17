import { copyButtonHtml } from "@agents-in-the-cloud/design-system/copy-button";
import { qrCodeButtonHtml, qrCodeDialogHtml } from "@agents-in-the-cloud/design-system/qr-code";
import { escapeHtml } from "@agents-in-the-cloud/shared";

export function agentsInTheCloudUrlHtml(agentsInTheCloudUrl: string, qrDialogId: string): string {
  return `<div class="agents-in-the-cloud-url"><a href="${escapeHtml(agentsInTheCloudUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(agentsInTheCloudUrl)}</a>${copyButtonHtml({ label: "Copy AgentsInTheCloud URL", copyText: agentsInTheCloudUrl })}${qrCodeButtonHtml(qrDialogId, "Show QR code")}</div>${qrCodeDialogHtml(qrDialogId, agentsInTheCloudUrl)}`;
}
