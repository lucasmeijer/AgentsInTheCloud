import { escapeHtml } from "@agents-in-the-cloud/shared";

export type HtmlContent =
  | { kind: "text"; text: string }
  /** Trusted, already-escaped HTML. */
  | { kind: "html"; html: string };

export function classNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

/** Components that render their own Stimulus wiring own these attributes; callers pass controllers and actions instead. */
export const stimulusAttributes = ["data-controller", "data-action"] as const;

export function attributesHtml(value?: string, owned: readonly string[] = []): string {
  const attributes = value?.trim();
  if (!attributes) return "";
  // Parse attribute boundaries, skipping quoted values (which may mention CSS).
  // Integration is intentionally extensible; component paint is not.
  const attribute = /([^\s=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  for (const match of attributes.matchAll(attribute)) {
    if (["class", "style", ...owned].includes(match[1]!.toLowerCase())) {
      throw new Error(`Design-system integration attributes cannot include ${match[1]}`);
    }
  }
  return ` ${attributes}`;
}

/**
 * Stimulus wiring rendered in the server markup. Turbo morphs reset attributes to
 * the server's, so wiring added on the client would be stripped.
 */
export function stimulusHtml(controllers: readonly (string | undefined)[], actions: readonly (string | undefined)[] = []): string {
  const controller = controllers.filter(Boolean).join(" ");
  const action = actions.filter(Boolean).join(" ");
  return `${controller ? ` data-controller="${escapeHtml(controller)}"` : ""}${action ? ` data-action="${escapeHtml(action)}"` : ""}`;
}

export function htmlContent(content: HtmlContent): string {
  return content.kind === "text" ? escapeHtml(content.text) : content.html;
}
