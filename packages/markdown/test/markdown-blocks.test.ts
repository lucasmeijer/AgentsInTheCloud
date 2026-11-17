import { expect, test } from "bun:test";
import { renderProvisionalMarkdown, renderProvisionalMarkdownBlocks } from "../src/markdown.ts";

const source = [
  "# Title",
  "Uses [a reference][r] and a [link](https://example.com).",
  "- one\n- two\n\n  loose",
  "| A | B |\n|---|---|\n| 1 | 2 |",
  "```ts\nconst x = 1;\n```",
  "$$\nx^2\n$$",
  "<details>\n<summary>Why</summary>\n\nBecause.\n\n</details>",
  "> quoted",
  "---",
  "[r]: https://example.com/ref",
].join("\n\n");

test("blocks render the whole document, one element each", () => {
  const blocks = renderProvisionalMarkdownBlocks("workspace", source)!;
  expect(blocks).toHaveLength(9);
  const betweenBlocks = (html: string) => html.replace(/>\s*\n\s*</g, "><");
  expect(betweenBlocks(blocks.join(""))).toBe(betweenBlocks(renderProvisionalMarkdown("workspace", source)));
  expect(blocks[1]).toContain('href="https://example.com/ref"');
});

test("an unclosed disclosure holds the rest of the document in one block", () => {
  const blocks = renderProvisionalMarkdownBlocks("workspace", "Intro\n\n<details>\n<summary>Why</summary>\n\nStill streaming\n\nMore")!;
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toStartWith("<details");
});
