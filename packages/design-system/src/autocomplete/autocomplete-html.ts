import { escapeHtml } from "@agents-in-the-cloud/shared";
import { attributesHtml, classNames, htmlContent, type HtmlContent } from "../html.ts";

interface AutocompleteResultsOptions {
  kind: "results";
  label: string;
  contentHtml: string;
  attributesHtml?: string;
}

interface AutocompleteMessageOptions {
  kind: "message";
  content: HtmlContent;
  role?: "status";
  attributesHtml?: string;
}

export type AutocompleteOptions = AutocompleteResultsOptions | AutocompleteMessageOptions;

export function autocompleteHtml(options: AutocompleteOptions): string {
  const results = options.kind === "results";
  const className = classNames("floating-surface", "autocomplete", results ? "action-list" : "autocomplete-empty");
  const semantics = results
    ? ` role="listbox" aria-label="${escapeHtml(options.label)}"`
    : options.role ? ` role="${options.role}"` : "";
  const content = results ? options.contentHtml : htmlContent(options.content);
  return `<div class="${escapeHtml(className)}"${semantics}${attributesHtml(options.attributesHtml)}>${content}</div>`;
}
