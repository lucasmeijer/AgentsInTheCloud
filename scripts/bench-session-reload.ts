import { piTranscriptRecords } from "../packages/pi-agent/src/server/transcript.ts";
import { isToolViewDetails } from "../packages/agent/src/server/transcript.ts";
import { claudeTranscriptRecords } from "../packages/claude-cli-agent/src/server/transcript.ts";

// Run with: bun scripts/bench-session-reload.ts [row-count]
// Measures history decoding/validation, not HTML rendering or container startup.
const count = Number(process.argv[2] ?? 10_000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("Expected a positive row count");
const timestamp = "2026-10-14T00:00:00Z";
const pi = Array.from({ length: count }, (_, index) => JSON.stringify({
  type: "message", id: `e${index}`, parentId: index ? `e${index - 1}` : null, timestamp,
  message: index % 2 ? {
    role: "toolResult", toolCallId: `c${index - 1}`, toolName: "bash",
    content: [{ type: "text", text: "Result ".repeat(30) }], isError: false, details: { exitCode: 0 },
  } : {
    role: "assistant", content: [
      { type: "thinking", thinking: "Checking the project" },
      { type: "toolCall", id: `c${index}`, name: "bash", arguments: { command: "git status" } },
    ], stopReason: "toolUse",
  },
})).join("\n") + "\n";
const claude = Array.from({ length: count }, (_, index) => JSON.stringify({
  type: index % 2 ? "user" : "assistant", uuid: `e${index}`, parentUuid: index ? `e${index - 1}` : null, timestamp,
  message: { content: index % 2
    ? [{ type: "tool_result", tool_use_id: `c${index - 1}`, content: "Result ".repeat(30) }]
    : [{ type: "tool_use", id: `c${index}`, name: "Bash", input: { command: "git status" } }],
  },
})).join("\n") + "\n";

function bench(name: string, run: () => void) {
  const start = performance.now();
  run();
  console.log(`${name}: ${Math.round(performance.now() - start)} ms`);
}
bench(`Pi ${count} rows`, () => {
  if (piTranscriptRecords(pi).length !== count) throw new Error("Pi history was truncated");
});
bench(`Claude CLI ${count} rows`, () => {
  if (claudeTranscriptRecords(claude).length !== count) throw new Error("Claude history was truncated");
});
bench(`Builtin ${count} tool details`, () => {
  for (let index = 0; index < count; index++) {
    if (!isToolViewDetails({ exitCode: 0, displayAnsi: "result" })) throw new Error("Invalid tool details");
  }
});
