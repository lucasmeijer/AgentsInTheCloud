import { languageFromPath } from "@agents-in-the-cloud/syntax/language";
import { Type, type Static } from "typebox";
import type { DiffEndpoints } from "./diff-endpoints.ts";

const line = Type.Integer({ minimum: 1 });
export const reviewCommentSchema = Type.Object({
  id: Type.String(), revision: Type.Integer({ minimum: 1 }), copiedRevision: Type.Integer({ minimum: 0 }),
  body: Type.String({ minLength: 1, maxLength: 10000 }), path: Type.String({ minLength: 1 }),
  side: Type.Union([Type.Literal("additions"), Type.Literal("deletions")]), start: line, end: line,
  comparison: Type.Object({ key: Type.String(), label: Type.String(), baseLabel: Type.String(), targetLabel: Type.String(), base: Type.Union([Type.String(), Type.Null()]), target: Type.String() }),
  anchor: Type.Object({ code: Type.Array(Type.String()), before: Type.Array(Type.String()), after: Type.Array(Type.String()) }),
});
export type ReviewComment = Static<typeof reviewCommentSchema>;
export type CommentPlacement = ReviewComment & { status: "inline" | "changed" | "other"; placedStart?: number; placedEnd?: number };
export type CommentAnnotation = { id: string; kind: "draft" | "comment"; path: string; side: ReviewComment["side"]; start: number; end: number; body: string; revision?: number };

export interface ReviewComparison {
  endpoints: DiffEndpoints; head?: string; resolvedBase: string | null;
}

export function reviewComparisonKey(comparison: ReviewComparison): string {
  const { endpoints, resolvedBase, head } = comparison;
  if (endpoints.target === "working" && resolvedBase === "staged") return "unstaged";
  if (resolvedBase === (head ?? null)) {
    if (endpoints.target === "working") return "uncommitted";
    if (endpoints.target === "staged") return "staged";
  }
  if (endpoints.base === undefined) return JSON.stringify(["parent", endpoints.target]);
  return JSON.stringify([endpoints.target, resolvedBase]);
}

export function textLines(contents: string): string[] {
  if (!contents) return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function captureCommentAnchor(contents: string, start: number, end: number): ReviewComment["anchor"] {
  const lines = textLines(contents);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) throw new RangeError("Select lines in this file.");
  return { code: lines.slice(start - 1, end), before: lines.slice(Math.max(0, start - 4), start - 1), after: lines.slice(end, end + 3) };
}

export function locateCommentAnchor(anchor: ReviewComment["anchor"], contents: string): { start: number; end: number } | undefined {
  const lines = textLines(contents);
  const needle = [...anchor.before, ...anchor.code, ...anchor.after];
  let match: { start: number; end: number } | undefined;
  for (let index = 0; index + needle.length <= lines.length; index++) {
    if (!needle.every((line, offset) => lines[index + offset] === line)) continue;
    if (match) return undefined;
    const start = index + anchor.before.length + 1;
    match = { start, end: start + anchor.code.length - 1 };
  }
  return match;
}

export function sortedComments<T extends ReviewComment>(comments: readonly T[]): T[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...comments].sort((a, b) => compare(a.path, b.path) || compare(a.comparison.key, b.comparison.key) || compare(a.side, b.side) || a.start - b.start || a.end - b.end || compare(a.id, b.id));
}

function userComment(body: string, language: string | undefined): string[] {
  const lines = body.split(/\r?\n/);
  const marked = lines.map((line, index) => index === 0 ? `USER COMMENT: ${line}` : line);
  switch (language) {
    case "python": case "ruby": case "bash": case "yaml": case "docker": case "terraform": case "hcl":
      return marked.map(line => `# ${line}`);
    case "sql":
      return marked.map(line => `-- ${line}`);
    case "css":
      return ["/* " + marked.join("\n * ") + " */"];
    case "html": case "xml": case "markdown": case "vue": case "svelte": case "astro":
      return ["<!-- " + marked.join("\n") + " -->"];
    case "erb":
      return marked.map(line => `<%# ${line} %>`);
    default:
      return marked.map((line, index) => index === 0 ? `//${line}` : `// ${line}`);
  }
}

export function exportReviewComments(comments: readonly CommentPlacement[]): string {
  const entries = sortedComments(comments).map(comment => {
    const before = [...comment.anchor.before, ...comment.anchor.code].slice(-Math.max(3, comment.anchor.code.length));
    const after = comment.anchor.after.slice(0, 3);
    const start = comment.end - before.length + 1;
    const end = comment.end + after.length;
    const language = languageFromPath(comment.path);
    const body = [...before, ...userComment(comment.body, language), ...after].join("\n");
    const filename = `${comment.path.replaceAll("\n", "\\n").replaceAll("\r", "\\r")}:${start}-${end}`;
    const info = `${language === "json" ? "jsonc" : language ?? "text"} ${filename.includes('"') ? filename : `filename="${filename}"`}`;
    const marker = info.includes("`") ? "~" : "`";
    const runs = marker === "`" ? /`+/g : /~+/g;
    const fence = marker.repeat(Math.max(3, ...[...body.matchAll(runs)].map(match => match[0].length + 1)));
    return `${fence}${info}\n${body}\n${fence}`;
  });
  return entries.length ? `${entries.join("\n\n")}\n` : "";
}
