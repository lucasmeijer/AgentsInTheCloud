import { codeToTokens, isSupportedLanguage, type Lang } from "@pierre/highlights";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { languageFromPath } from "./language.ts";
import { agentsInTheCloudTheme } from "./theme.ts";

export { languageFromPath } from "./language.ts";

const aliases = new Map(Object.entries({
  ts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", htm: "html", yml: "yaml",
  dockerfile: "docker", shell: "bash", sh: "bash", zsh: "bash", cs: "csharp", csx: "csharp", md: "markdown",
  py: "python", rb: "ruby", rs: "rust", tf: "terraform", protobuf: "proto",
  erb: "html",
}));

const colorRole = /^var\(--syntax-([\w-]+)/;

export interface HighlightRequest { code: string; path?: string; language?: string }
export interface HighlightedCode { readonly html: string; readonly language?: string }

function resolveLanguage(language: string | undefined): Lang | undefined {
  const raw = language?.trim().toLowerCase();
  if (!raw) return undefined;
  const resolved = aliases.get(raw) ?? raw;
  return isSupportedLanguage(resolved) ? resolved : undefined;
}

export function highlightCodeHtml(request: HighlightRequest): HighlightedCode {
  const language = resolveLanguage(request.language ?? languageFromPath(request.path));
  if (!language) return { html: escapeHtml(request.code) };
  const lines = codeToTokens(request.code, { lang: language, theme: agentsInTheCloudTheme }).tokens;
  const html = lines.map((tokens) => tokens.map((token) => {
    const escaped = escapeHtml(token.content);
    const role = token.color?.match(colorRole)?.[1];
    return role && role !== "foreground" ? `<span class="syntax-${role}">${escaped}</span>` : escaped;
  }).join("")).join("\n");
  return { html, language };
}

export function highlightCodeHtmlForPath(code: string, filePath?: string): HighlightedCode {
  return highlightCodeHtml({ code, path: filePath });
}
