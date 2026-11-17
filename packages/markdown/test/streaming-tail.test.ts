import { describe, expect, test } from "bun:test";
import { repairStreamingMarkdownTail } from "../src/streaming-markdown.ts";

describe("streaming Markdown parsing copies", () => {
  test("does not manufacture fence closers or repair content inside open fences", () => {
    for (const source of [
      "```ts\nconst x = *literal;\n",
      "```ts\nconst value = **not emphasis**;",
      "~~~ts\nconst value = **not emphasis**;",
      "~~~text\n![incomplete image](https://example.com",
      "- Example:\n\n  ```ts\n  const x = 1;\n",
      "- Example:\n\n  ~~~text\n  *literal emphasis",
      "```bad`info\nThis is not a valid fenced block.\n",
      "```text\u2028label\nfirst\n\nsecond\n",
      "```text\nfirst\n```\u00a0\n\n*still code",
    ]) expect(repairStreamingMarkdownTail(source)).toBe(source);
  });

  test("unmatched backtick runs suppress emphasis repairs regardless of run length", () => {
    for (const opening of ["`", "``", "```", "````"]) {
      for (const other of ["", "`", "``", "```", "````"]) {
        if (opening === other) continue;
        const source = `Use ${opening}code ${other} and a *literal marker`;
        expect(repairStreamingMarkdownTail(source)).toBe(source);
      }
    }
  });

  test("equal-length runs close spans while other runs and backslashes inside are literal", () => {
    for (const span of ["`code`", "``code ` literal``", "``code ``` literal``", "`code\\`", "``code\\``"]) {
      const source = `${span} and *emphasis`;
      expect(repairStreamingMarkdownTail(source)).toBe(`${source}*`);
    }
    expect(repairStreamingMarkdownTail("\\`literal and *emphasis")).toBe("\\`literal and *emphasis*");
    expect(repairStreamingMarkdownTail("\\``open and *literal")).toBe("\\``open and *literal");
  });
});

test("leaves incomplete equations untouched instead of inventing emphasis closers", () => {
  for (const source of ["$$\nx*y", "\\[\nx*y", "The answer is $x*y", "The answer is \\(x*y"]) {
    expect(repairStreamingMarkdownTail(source)).toBe(source);
  }
});
