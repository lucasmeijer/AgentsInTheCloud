import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";

interface AgentTypeChoice { id: string; label: string; iconHtml: string }

const agentOrder = ["builtin", "pi", "claude", "claude-cli", "codex", "codex-cli"];

export function renderAgentTypePicker(agentTypes: readonly AgentTypeChoice[], options: {
  attributes: (agentType: AgentTypeChoice) => string;
}): string {
  const rows = agentTypes.toSorted((a, b) => agentOrder.indexOf(a.id) - agentOrder.indexOf(b.id)).map(agentType => contentRowHtml({
    kind: "compact", width: "fill", leadingHtml: agentType.iconHtml,
    label: { kind: "text", text: agentType.id === "builtin" ? `${agentType.label} (Lucas' favorite!)` : agentType.label },
    element: { tag: "button", attributesHtml: options.attributes(agentType) },
  })).join("");
  return `<div class="agent-type-picker action-list">${rows}</div>`;
}
