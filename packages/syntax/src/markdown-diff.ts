import { createCoreStyleElement, createStyleElement, createThemeStyleElement, DiffHunksRenderer, parsePatchFiles, preloadHighlighter, wrapThemeCSS, type ParsedPatch } from "@pierre/diffs";
import { renderHTML } from "@pierre/diffs/ssr";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { toolDiffOptions } from "./pierre.ts";
import { wordDiffCSS } from "./diff-options.ts";
import { HighlightCache } from "./highlight-cache.ts";

// Markdown rendering is synchronous. Load the neutral diff theme up front;
// code fences emphasize the patch structure rather than language tokens.
await preloadHighlighter({ themes: [toolDiffOptions.theme], langs: ["text"], preferredHighlighter: toolDiffOptions.preferredHighlighter });
const cache = new HighlightCache(2_000_000, 128);

export function renderMarkdownDiff(code: string, provisional = false): string {
  if (provisional || !/^(?:diff --git |--- )/m.test(code)) return renderSnippet(code);
  const cached = cache.get(code);
  if (cached) return cached.html;
  let patches: ParsedPatch[];
  // Incomplete or malformed external input stays readable as a snippet.
  try {
    patches = parsePatchFiles(code, { throwOnError: true });
  } catch {
    return renderSnippet(code);
  }
  const files = patches.flatMap((patch) => patch.files);
  // Metadata-only/binary changes remain verbatim instead of disappearing.
  if (!files.length || files.some((file) => !file.hunks.length)) return renderSnippet(code);
  const html = patches.map((patch) => {
    const metadata = patch.patchMetadata ? renderSnippet(patch.patchMetadata) : "";
    return metadata + patch.files.map((file) => {
      const renderer = new DiffHunksRenderer({ ...toolDiffOptions, diffIndicators: "classic", hunkSeparators: "metadata", lineDiffType: "word-alt" });
      const result = renderer.renderDiff({ ...file, lang: "text" })!;
      const rendered = renderHTML([
        createCoreStyleElement(),
        createThemeStyleElement(wrapThemeCSS(result.themeStyles, result.baseThemeType ?? "dark")),
        createStyleElement(`${toolDiffOptions.unsafeCSS} ${wordDiffCSS}`),
        renderer.renderFullAST(result),
      ]);
      renderer.cleanUp();
      const name = file.prevName && file.prevName !== file.name ? `${file.prevName} → ${file.name}` : file.name;
      return `<section class="markdown-diff-file agents-in-the-cloud-pierre-host"><div class="markdown-diff-filename">${escapeHtml(name)}</div><diffs-container data-controller="markdown-diff"><template data-markdown-diff-content>${rendered}</template></diffs-container></section>`;
    }).join("");
  }).join("");
  cache.set(code, { html });
  return html;
}

function renderSnippet(code: string): string {
  let oldRemaining = 0;
  let newRemaining = 0;
  const lines = code.split("\n").map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    let kind = "context";
    if (hunk) {
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      kind = "hunk";
    } else if (!(oldRemaining || newRemaining) && /^(?:diff |index |--- |\+\+\+ |(?:old|new|deleted file) mode |similarity index |rename (?:from|to) |Binary files |GIT binary patch)/.test(line)) {
      kind = "meta";
    } else if (line.startsWith("+")) {
      kind = "addition";
      newRemaining = Math.max(0, newRemaining - 1);
    } else if (line.startsWith("-")) {
      kind = "deletion";
      oldRemaining = Math.max(0, oldRemaining - 1);
    } else if (line.startsWith("\\")) {
      kind = "meta";
    } else if (line.startsWith(" ")) {
      oldRemaining = Math.max(0, oldRemaining - 1);
      newRemaining = Math.max(0, newRemaining - 1);
    }
    const modifier = kind === "context" ? "" : ` markdown-diff-line--${kind}`;
    return `<span class="markdown-diff-line${modifier}">${escapeHtml(line)}</span>`;
  });
  return `<pre class="markdown-diff-snippet" data-lang="diff"><code>${lines.join("\n")}</code></pre>`;
}
