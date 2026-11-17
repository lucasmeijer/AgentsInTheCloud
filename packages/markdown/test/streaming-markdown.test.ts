import { describe, expect, test } from "bun:test";
import {
  StreamingMarkdownRenderer,
  renderStreamingMarkdownSnapshot,
  repairStreamingMarkdownTail,
  streamingMarkdownStableBoundary,
} from "../src/streaming-markdown.ts";
import { renderMarkdown } from "../src/markdown.ts";

const workspaceId = "stream workspace";

describe("streaming Markdown", () => {
  test("advances completed paragraph and heading boundaries monotonically", () => {
    const renderer = new StreamingMarkdownRenderer(workspaceId);
    const prefixes = ["First", "First\n\n", "First\n\n# Heading", "First\n\n# Heading\n\nTail"];
    const boundaries = prefixes.map((prefix) => renderer.render(prefix).stableBoundary);
    expect(boundaries).toEqual([0, 7, 7, 18]);
    expect(boundaries.every((boundary, index) => index === 0 || boundary >= boundaries[index - 1]!)).toBe(true);
    const update = renderer.render(`${prefixes.at(-1)} text`);
    expect(update.stableHtmlAddition).toBe("");
    expect(update.tailHtml).toContain("<p>Tail text</p>");
  });

  test("never commits part of a disclosure that later renders differently", () => {
    for (const source of [
      "Intro\n\n<details>\n<summary>S</summary>\n\nReason\n\n```\n</details>\n```\n\n</details>\n\nAfter\n\n",
      "<details>\n<summary>S</summary>\n\n- ```js\n  x\n  ```\n\n</details>\n\nAfter\n\n",
      "<details>\n<summary>Outer</summary>\n\n- <details>\n  <summary>Inner</summary>\n\n  inner\n  </details>\n\nstill outer\n\n</details>\n\nAfter\n\n",
    ]) {
      const final = renderMarkdown(workspaceId, source).replaceAll("\n", "");
      const renderer = new StreamingMarkdownRenderer(workspaceId);
      let stable = "";
      for (let end = 1; end <= source.length; end++) {
        stable += renderer.render(source.slice(0, end)).stableHtmlAddition;
        expect(final.startsWith(stable.replaceAll("\n", ""))).toBe(true);
      }
    }
  });

  test("keeps protected block constructs and everything after them in the mutable tail", () => {
    const prefix = "before\n\n";
    for (const tail of [
      "- item\n  continuation\n\nnext\n\n",
      "> quote\n> continued\n\nnext\n\n",
      "| A | B |\n|---|---|\n| 1 | 2 |\n\nnext\n\n",
      "```ts\nconst x = 1;\n\nnext\n\n",
      "![preview](artifact-preview:/work/preview",
      "[file](agents-in-the-cloud://file/work/a.ts",
    ]) {
      expect(streamingMarkdownStableBoundary(prefix + tail)).toBe(prefix.length);
    }
  });

  test("provisionally closes clear emphasis without changing escaped markers or inline code", () => {
    expect(repairStreamingMarkdownTail("A *clear emphasis")).toBe("A *clear emphasis*");
    expect(repairStreamingMarkdownTail("A **clear strong")).toBe("A **clear strong**");
    expect(repairStreamingMarkdownTail("A \\*escaped")).toBe("A \\*escaped");
    expect(repairStreamingMarkdownTail("Use `an *unfinished marker")).toBe("Use `an *unfinished marker");
  });

  test("completes safe links and degrades unfinished images", () => {
    expect(repairStreamingMarkdownTail("[site](https://example.com/path")).toEndWith(")");
    expect(repairStreamingMarkdownTail("[file](agents-in-the-cloud://file/work/a.ts")).toEndWith(")");
    expect(repairStreamingMarkdownTail("[bad](javascript:alert")).toBe("[bad](javascript:alert");
    const image = renderStreamingMarkdownSnapshot(workspaceId, "![alt](https://example.com/incomplete");
    expect(image.tailHtml).not.toContain("<img");
    expect(image.tailHtml).toContain("![alt]");
  });

  test("preserves canonical safety and features in streaming snapshots", () => {
    const source = [
      "<script>alert(1)</script>",
      "",
      "[web](https://example.com) [file](agents-in-the-cloud://file/work/a.ts)",
    ].join("\n");
    const snapshot = renderStreamingMarkdownSnapshot(workspaceId, source);
    const html = snapshot.stableHtml + snapshot.tailHtml;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('target="_blank"');
  });
});
