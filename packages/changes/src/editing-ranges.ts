import type { EditedCommentRange } from "./editing.ts";

interface LineChange { range: { start: { line: number; character?: number }; end: { line: number; character?: number } }; text: string }

export function moveCommentRanges(ranges: readonly EditedCommentRange[], changes: readonly LineChange[]): EditedCommentRange[] {
  const edits = [...changes].sort((a, b) => b.range.start.line - a.range.start.line || (b.range.start.character ?? 0) - (a.range.start.character ?? 0));
  function move(line: number, edge: "start" | "end"): number {
    let position = line - 1;
    for (const change of edits) {
      const start = change.range.start.line, end = change.range.end.line;
      const added = (change.text.match(/\r\n|\r|\n/g) ?? []).length;
      if (position > end) position += added - (end - start);
      else if (position === start && start === end) {
        const insertion = (change.range.start.character ?? 0) === (change.range.end.character ?? 0);
        if (edge === "end" || (insertion && (change.range.start.character ?? 0) === 0)) position += added;
      } else if (position >= start) position = start + Math.min(position - start, added);
    }
    return position + 1;
  }
  return ranges.map(range => ({ ...range, start: move(range.start, "start"), end: move(range.end, "end") }));
}
