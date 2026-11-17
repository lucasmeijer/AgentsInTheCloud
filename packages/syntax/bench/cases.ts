import { readFileSync } from "node:fs";

export const fixtures = ["style.css", "view.js", "board.js", "constructor.js", "index.html"] as const;
export const paths = ["syntax", "markdown", "write", "read", "bash", "review", "tool-diff", "editor"] as const;
export type HighlightPath = typeof paths[number];
export type Fixture = typeof fixtures[number];

export function source(fixture: Fixture): string {
  return readFileSync(new URL(`../test/fixtures/slay/${fixture}.txt`, import.meta.url), "utf8");
}

export function* prefixes(text: string, chunkSize: number): Generator<string> {
  for (let end = chunkSize; end < text.length; end += chunkSize) yield text.slice(0, end);
  yield text;
}

export interface Sample {
  step: number;
  inputCharacters: number;
  elapsedMs: number;
  highlightCalls: number;
  highlightedCharacters: number;
  maxHighlightMs: number;
}
