import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { escapeHtml } from "@agents-in-the-cloud/shared";

export function renderTerminalConnectionStatus(controller: string): string {
  return `<div class="observable-terminal-connection" data-${escapeHtml(controller)}-target="connectionStatus" data-state="connecting" role="status" aria-live="polite">
    <span data-terminal-connection-state="connecting">Connecting to terminal…</span>
    <span data-terminal-connection-state="reconnecting" hidden>Connection lost. Reconnecting…</span>
    <span data-terminal-connection-state="unavailable" hidden>Could not reconnect to terminal.</span>
    ${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Retry connection" }, attributesHtml: `data-action="${escapeHtml(controller)}#retry"` })}
  </div>`;
}
