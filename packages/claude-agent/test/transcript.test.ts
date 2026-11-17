import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "@agents-in-the-cloud/core";
import { claudeRows, claudeText } from "../src/server/rows.ts";
import { ClaudeState } from "../src/server/state.ts";
import { projectClaudeTranscript } from "../src/server/transcript.ts";
import { workingCommentaryItems } from "@agents-in-the-cloud/agent/server/render-transcript";
import type { TranscriptItem } from "@agents-in-the-cloud/agent/server/transcript";

const time = (second: number) => `2026-10-12T12:00:${String(second).padStart(2, "0")}.000Z`;
const user = (uuid: string, second: number, content: JsonValue, extra: JsonObject = {}) => ({ type: "user", uuid, timestamp: time(second), message: { role: "user", content }, ...extra });
const assistant = (uuid: string, second: number, id: string, content: JsonValue[], stop_reason: string | null = null) => ({ type: "assistant", uuid, timestamp: time(second), message: { id, content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } } });
const jsonl = (...rows: JsonObject[]) => rows.map(row => JSON.stringify(row)).join("\n");
// SAFETY: Fixtures carry the fields of the SDK messages ClaudeState reads; tests omit unrelated ones.
const sdk = (message: JsonObject): SDKMessage => JSON.parse(JSON.stringify(message));
const state = (rows: string) => { const value = new ClaudeState(); value.hydrate(claudeRows(rows)); return value; };

test("groups a prompt's thinking and tool calls into a turn, and steering starts its own with the final answer", () => {
  const items = projectClaudeTranscript(state(jsonl(
    { type: "queue-operation", operation: "enqueue" },
    user("prompt", 0, [{ type: "text", text: "Run date" }]),
    { type: "attachment", uuid: "meta", timestamp: time(0), attachment: { type: "total_tokens_reminder" } },
    assistant("a1", 1, "msg_1", [{ type: "thinking", thinking: "Checking the clock." }]),
    assistant("a2", 1, "msg_1", [{ type: "text", text: "Running date." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "date" } }], "tool_use"),
    user("result", 2, [{ type: "tool_result", tool_use_id: "toolu_1", content: "Mon Oct 12", is_error: false }]),
    { type: "attachment", uuid: "steer-row", timestamp: time(3), attachment: { type: "queued_command", prompt: [{ type: "text", text: "Also be brief." }], source_uuid: "steer" } },
    assistant("a3", 4, "msg_2", [{ type: "text", text: "It is Monday." }], "end_turn"),
  )), false);
  expect(items.map(item => item.type)).toEqual(["user", "working", "user", "working", "text"]);
  const [prompt, interrupted, steering, steered, final] = items;
  expect(prompt).toMatchObject({ key: "prompt", text: "Run date" });
  expect(steering).toEqual({ type: "user", key: "steer", text: "Also be brief.", images: [] });
  expect(final).toMatchObject({ key: "msg_2:0", text: "It is Monday.", final: true });
  if (interrupted?.type !== "working" || steered?.type !== "working") throw new Error("Expected working sections");
  expect(interrupted).toMatchObject({ startedAt: Date.parse(time(0)), completedAt: Date.parse(time(3)), hasFinalAnswer: false, live: false });
  expect(interrupted.items.map(item => [item.type, item.key])).toEqual([["thinking", "msg_1:0"], ["text", "msg_1:1"], ["tool", "tool:toolu_1"]]);
  expect(interrupted.items[2]).toMatchObject({ tool: { name: "bash", args: { command: "date" }, status: "ok", resultText: "Mon Oct 12", durationMs: 1000 } });
  expect(steered).toMatchObject({ key: "steer:working", startedAt: Date.parse(time(3)), completedAt: Date.parse(time(4)), hasFinalAnswer: true, items: [] });
});

test("shows interruptions as stopped turns, and slash commands as the prompts they were", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("first", 0, [{ type: "text", text: "Write an essay" }]),
    user("interrupt", 2, [{ type: "text", text: "[Request interrupted by user]" }]),
    user("model-caveat", 3, "<local-command-caveat>Caveat</local-command-caveat>", { isMeta: true }),
    user("model", 3, "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>haiku</command-args>"),
    user("model-output", 3, "<local-command-stdout>Set model to haiku</local-command-stdout>"),
    { type: "system", subtype: "compact_boundary", uuid: "boundary", timestamp: time(9) },
    user("summary", 9, "This session is being continued…", { isCompactSummary: true }),
    user("compact", 5, "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"),
    user("compact-output", 9, "<local-command-stdout>Compacted </local-command-stdout>"),
  )), false);
  expect(items.map(item => [item.type, "text" in item ? item.text : undefined])).toEqual([["user", "Write an essay"], ["working", undefined], ["user", "/compact"], ["working", undefined], ["text", "Compacted"]]);
  expect(items[1]).toMatchObject({ stoppedAt: Date.parse(time(2)), items: [] });
  expect(items[3]).toMatchObject({ completedAt: Date.parse(time(9)), items: [{ type: "note", text: "Claude compacted the conversation." }] });
  expect(items[4]).toMatchObject({ final: true });
});

test("answers a command with its output, which history replaces once recorded", () => {
  const value = new ClaudeState();
  value.add({ kind: "user", uuid: "review", timestamp: Date.parse(time(0)), content: [{ type: "text", text: "/code-review" }], meta: false });
  value.receive(sdk({ type: "assistant", uuid: "findings", session_id: "s", parent_tool_use_id: null, message: { id: "d774d465", model: "<synthetic>", content: [{ type: "text", text: "Two bugs." }], stop_reason: "end_turn" } }));
  expect(projectClaudeTranscript(value, false)[2]).toMatchObject({ type: "text", key: "findings:output", text: "Two bugs.", final: true });
  const command = [
    user("review-caveat", 0, "<local-command-caveat>Caveat</local-command-caveat>", { isMeta: true }),
    user("review-echo", 0, "/code-review"),
    { type: "system", subtype: "local_command", uuid: "invocation", timestamp: time(1), content: "<command-name>/code-review</command-name>", isMeta: false },
    { type: "system", subtype: "local_command", uuid: "findings", timestamp: time(5), content: "<local-command-stdout>Two bugs.</local-command-stdout>", isMeta: false },
  ];
  value.merge(claudeRows(jsonl(...command)));
  value.merge(claudeRows(jsonl(
    ...command,
    user("fix", 6, "fix them all"),
    assistant("a1", 7, "msg_1", [{ type: "tool_use", id: "toolu_1", name: "Edit", input: {} }], "tool_use"),
    user("result", 8, [{ type: "tool_result", tool_use_id: "toolu_1", content: "Updated" }]),
    assistant("a2", 9, "msg_2", [{ type: "text", text: "Fixed both." }], "end_turn"),
  )));
  expect(value.rows.flatMap(row => row.kind === "user" && !row.meta && !row.content.some(block => block.type === "tool_result") ? [claudeText(row.content)] : [])).toEqual(["/code-review", "fix them all"]);
  const items = projectClaudeTranscript(value, false);
  expect(items.map(item => [item.type, "text" in item ? item.text : undefined])).toEqual([["user", "/code-review"], ["working", undefined], ["text", "Two bugs."], ["user", "fix them all"], ["working", undefined], ["text", "Fixed both."]]);
  expect(items[2]).toMatchObject({ key: "findings:output", final: true });
  expect(items[5]).toMatchObject({ final: true });
});

test("notes command output that answers no command, and shows its errors as errors", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("prompt", 0, "Explain the diff"),
    { type: "system", subtype: "local_command", uuid: "stray", timestamp: time(1), content: "<local-command-stdout>Queued output</local-command-stdout>" },
    assistant("a1", 2, "msg_1", [{ type: "text", text: "It renames a function." }], "end_turn"),
    user("bad", 3, "/code-review nowhere"),
    { type: "system", subtype: "local_command", uuid: "failed", timestamp: time(4), content: "<local-command-stderr>Not a branch</local-command-stderr>" },
  )), false);
  expect(items.map(item => [item.type, "text" in item ? item.text : undefined])).toEqual([["user", "Explain the diff"], ["working", undefined], ["text", "It renames a function."], ["user", "/code-review nowhere"], ["working", undefined]]);
  expect(items[1]).toMatchObject({ items: [{ type: "note", text: "Queued output", tone: "system" }] });
  expect(items[4]).toMatchObject({ hasFinalAnswer: false, items: [{ type: "note", text: "Not a branch", tone: "error" }] });
});

test("streams blocks under the keys their committed messages keep", () => {
  const value = state(jsonl(user("prompt", 0, [{ type: "text", text: "Hi" }])));
  const event = (event: JsonObject) => value.receive(sdk({ type: "stream_event", event, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s" }));
  event({ type: "message_start", message: { id: "msg_1" } });
  event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } });
  event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } });
  const live = projectClaudeTranscript(value, true);
  expect(live).toMatchObject([{ type: "user" }, { type: "working", live: true, items: [{ type: "thinking", key: "msg_1:0", text: "Hmm", live: true }, { type: "text", key: "msg_1:1", text: "Hello", live: true }] }]);
  value.receive(sdk({ type: "assistant", uuid: "a1", session_id: "s", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "thinking", thinking: "Hmm" }], stop_reason: null } }));
  expect(projectClaudeTranscript(value, true)[1]).toMatchObject({ items: [{ key: "msg_1:0", live: false }, { key: "msg_1:1", text: "Hello", live: true }] });
  value.receive(sdk({ type: "assistant", uuid: "a2", session_id: "s", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn" } }));
  event({ type: "message_stop" });
  expect(projectClaudeTranscript(value, false).slice(1)).toMatchObject([{ type: "working", hasFinalAnswer: true, items: [{ key: "msg_1:0" }] }, { type: "text", key: "msg_1:1", final: true, live: false }]);
});

test("ignores the conversations of Claude's own subagents", () => {
  const value = state(jsonl(user("prompt", 0, [{ type: "text", text: "Delegate" }]), { ...assistant("side", 1, "msg_side", [{ type: "text", text: "Subagent work" }]), isSidechain: true }));
  value.receive(sdk({ type: "assistant", uuid: "nested", session_id: "s", parent_tool_use_id: "toolu_task", message: { id: "msg_nested", content: [{ type: "text", text: "Nested" }], stop_reason: null } }));
  expect(JSON.stringify(projectClaudeTranscript(value, false))).not.toMatch(/Subagent work|Nested/);
});

test("history replaces streamed rows, keeps unrecorded prompts and drops prompts Claude echoed as commands", () => {
  const value = new ClaudeState();
  value.add({ kind: "user", uuid: "sent", timestamp: Date.parse(time(0)), content: [{ type: "text", text: "Hello" }], meta: false });
  value.add({ kind: "user", uuid: "local-compact", timestamp: Date.parse(time(5)), content: [{ type: "text", text: "/compact" }], meta: false });
  value.add({ kind: "steer", uuid: "queued", timestamp: Date.parse(time(6)), content: [{ type: "text", text: "Still waiting" }] });
  value.merge(claudeRows(jsonl(user("sent", 0, [{ type: "text", text: "Hello" }]), user("echo", 5, "<command-name>/compact</command-name><command-args></command-args>"))));
  expect(value.rows.map(row => row.uuid)).toEqual(["sent", "echo", "queued"]);
});

const notification = (taskId: string, toolUseId: string, summary: string, extra = "") => `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>${extra}\n</task-notification>`;
const outline = (item: TranscriptItem | undefined) => item?.type === "message" ? ["message", item.sender, item.title] : [item?.type, "text" in item! ? item.text : undefined];

test("Claude's report on finished background work is a turn of its own, after the answer that started it", () => {
  const started = jsonl(
    user("prompt", 0, [{ type: "text", text: "Run the suite in the background" }]),
    assistant("a1", 1, "msg_1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "bun test", run_in_background: true } }]),
    user("result", 1, [{ type: "tool_result", tool_use_id: "toolu_1", content: "Running in background", is_error: false }]),
    assistant("a2", 2, "msg_2", [{ type: "text", text: "Started the suite." }]),
  );
  const value = state(started);
  value.add({ kind: "task", uuid: "announced", timestamp: Date.parse(time(8)), runId: "run-1", toolUseId: "toolu_1", status: "completed", summary: "Background command \"Run tests\" completed (exit code 0)" });
  const live = projectClaudeTranscript(value, true);
  expect(live.map(outline)).toEqual([["user", "Run the suite in the background"], ["working", undefined], ["text", "Started the suite."], ["message", "bun test", "finished"], ["working", undefined]]);
  expect(live.map(item => item.type === "working" && item.live)).toEqual([false, false, false, false, true]);
  expect(live[3]).toMatchObject({ dispatchedByToolCallId: "toolu_1", details: { Summary: "Background command \"Run tests\" completed (exit code 0)", Duration: "7s" } });
  const reported = started + "\n" + jsonl(
    user("recorded", 8, notification("suite", "toolu_1", "Background command \"Run tests\" completed (exit code 0)"), { origin: { kind: "task-notification", runId: "run-1" } }),
    assistant("a3", 9, "msg_3", [{ type: "text", text: "All tests pass." }]),
  );
  value.merge(claudeRows(reported));
  expect(projectClaudeTranscript(value, false).map(outline)).toEqual([
    ["user", "Run the suite in the background"], ["working", undefined], ["text", "Started the suite."],
    ["message", "bun test", "finished"], ["working", undefined], ["text", "All tests pass."],
  ]);
  value.add({ kind: "task", uuid: "announced-again", timestamp: Date.parse(time(20)), runId: "run-2", status: "completed", summary: "Background command \"Run tests\" completed" });
  value.merge(claudeRows(reported));
  expect(value.rows.at(-1)).toMatchObject({ uuid: "announced-again" });
});

test("a subagent's report, type and usage show in its message, which hides with the turn's work once it answers", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("prompt", 0, [{ type: "text", text: "Review auth, then build" }]),
    assistant("a1", 1, "msg_1", [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "Auth review", subagent_type: "general-purpose", prompt: "Review src/auth", run_in_background: true } }]),
    user("launched", 1, [{ type: "tool_result", tool_use_id: "toolu_agent", content: "Async agent launched", is_error: false }]),
    assistant("a2", 2, "msg_2", [{ type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "bun run build" } }]),
    user("built", 40, [{ type: "tool_result", tool_use_id: "toolu_build", content: "Built", is_error: false }]),
    { type: "attachment", uuid: "task", timestamp: time(41), attachment: { type: "queued_command", prompt: notification("review", "toolu_agent", "Agent \"Auth review\" finished", "\n<result>No issues in **src/auth**.</result>\n<usage><subagent_tokens>41200</subagent_tokens><tool_uses>23</tool_uses><duration_ms>134000</duration_ms></usage>"), source_uuid: "queued", runId: "run-1" } },
    assistant("a3", 42, "msg_3", [{ type: "text", text: "Built, and the review found nothing." }]),
  )), false);
  expect(items.map(item => item.type)).toEqual(["user", "working", "text"]);
  const working = items[1];
  if (working?.type !== "working") throw new Error("Expected a working section");
  expect(working.items.map(outline)).toEqual([["tool", undefined], ["tool", undefined], ["message", "Auth review", "finished"]]);
  expect(working.items[2]).toEqual({
    type: "message", key: "task", timestamp: Date.parse(time(41)), sender: "Auth review", title: "finished", bodyMarkdown: "No issues in **src/auth**.", dispatchedByToolCallId: "toolu_agent",
    details: { Summary: "Agent \"Auth review\" finished", Type: "general-purpose", Duration: "2m14s", "Tool uses": "23", Tokens: "41.2k" },
  });
  expect(workingCommentaryItems({ ...working, completedAt: undefined }).map(item => item.key)).toEqual(["task"]);
  expect(workingCommentaryItems(working)).toEqual([]);
});

test("prompts may start with any tag; only Claude's own tagged messages stay hidden", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("pasted", 0, [{ type: "text", text: "<pasted_content>\nlog\n</pasted_content>\nWhy?" }]),
    user("reminder", 1, "<system-reminder>Internal</system-reminder>"),
    assistant("a1", 2, "msg_1", [{ type: "text", text: "Because." }], "end_turn"),
    user("html", 3, [{ type: "text", text: "<div>Fix this</div> <command-name>/compact</command-name>" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]),
    assistant("a2", 4, "msg_2", [{ type: "text", text: "Fixed." }], "end_turn"),
  )), false);
  expect(items.map(item => [item.type, "text" in item ? item.text : undefined])).toEqual([
    ["user", "<pasted_content>\nlog\n</pasted_content>\nWhy?"], ["working", undefined], ["text", "Because."],
    ["user", "<div>Fix this</div> <command-name>/compact</command-name>"], ["working", undefined], ["text", "Fixed."],
  ]);
  expect(items[3]).toMatchObject({ images: [{ entryId: "html", contentIndex: 0 }] });
});

test("a turn that ends in an error shows as stopped, with the error after it", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("prompt", 0, [{ type: "text", text: "Run date" }]),
    assistant("a1", 1, "msg_1", [{ type: "text", text: "Checking." }]),
    { ...assistant("failed", 9, "msg_2", [{ type: "text", text: "API Error: 502 OAuth refresh failed" }], "stop_sequence"), isApiErrorMessage: true },
  )), false);
  expect(items.map(item => item.type)).toEqual(["user", "working", "error"]);
  expect(items[1]).toMatchObject({ stoppedAt: Date.parse(time(9)), hasFinalAnswer: false, items: [{ type: "text", text: "Checking." }] });
  expect(items[1]).not.toHaveProperty("completedAt");
  expect(items[2]).toMatchObject({ key: "failed:error", text: "API Error: 502 OAuth refresh failed" });
});

test("references prompt images by their row and position", () => {
  const items = projectClaudeTranscript(state(jsonl(user("with-image", 0, [{ type: "text", text: "Look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]))), false);
  expect(items[0]).toMatchObject({ type: "user", images: [{ entryId: "with-image", contentIndex: 0, mimeType: "image/png" }] });
});

test("shows the images a steering message carried", () => {
  const items = projectClaudeTranscript(state(jsonl(
    user("prompt", 0, [{ type: "text", text: "Run date" }]),
    assistant("a1", 1, "msg_1", [{ type: "thinking", thinking: "Checking the clock." }]),
    { type: "attachment", uuid: "steer-row", timestamp: time(2), attachment: { type: "queued_command", prompt: [{ type: "text", text: "Like this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }], source_uuid: "steer" } },
  )), true);
  expect(items.map(item => item.type)).toEqual(["user", "working", "user", "working"]);
  expect(items[2]).toMatchObject({ type: "user", text: "Like this", images: [{ entryId: "steer", contentIndex: 0, mimeType: "image/png" }] });
  expect(items[3]).toMatchObject({ live: true });
});
