import { expect, test } from "bun:test";
import { applyTranscriptContributions } from "../../src/server/transcript-contributions.ts";
import type { TranscriptItem } from "../../src/server/transcript.ts";

const message = (key: string, timestamp: number): Extract<TranscriptItem, { type: "message" }> => ({ type: "message", key, timestamp, sender: "reviewer", title: "result", details: {} });

test("messages that arrive while a turn runs join that turn; others sit between turns", () => {
  const items: TranscriptItem[] = [
    { type: "user", key: "prompt", text: "Review", images: [], timestamp: 1000 },
    { type: "working", key: "turn", startedAt: 1000, completedAt: 5000, hasFinalAnswer: true, items: [
      { type: "text", key: "before", text: "Waiting.", final: false, timestamp: 2000 },
      { type: "text", key: "after", text: "Got it.", final: false, timestamp: 4000 },
    ] },
    { type: "text", key: "answer", text: "Done.", final: true, timestamp: 5000 },
    { type: "working", key: "live", startedAt: 8000, live: true, items: [] },
  ];
  const result = applyTranscriptContributions(items, { anchors: [], messages: [message("during", 3000), message("between", 6000), message("live", 9000)] });
  expect(result.map(item => item.key)).toEqual(["prompt", "turn", "answer", "between", "live"]);
  expect(result[1]?.type === "working" && result[1].items.map(item => item.key)).toEqual(["before", "during", "after"]);
  expect(result[4]?.type === "working" && result[4].items.map(item => item.key)).toEqual(["live"]);
  expect(items[1]?.type === "working" && items[1].items.map(item => item.key)).toEqual(["before", "after"]);
});
