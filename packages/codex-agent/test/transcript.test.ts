import { expect, test } from "bun:test";
import { projectCodexTurns } from "../src/server/transcript.ts";
import type { Turn } from "../src/protocol.ts";

test("a subagent's activity reaches the transcript as an incoming message from its background activity", () => {
  const [working] = projectCodexTurns([{
    id: "turn", itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: [{ type: "subAgentActivity", id: "activity", kind: "completed", agentThreadId: "thread-2", agentPath: "/root/researcher" }],
  }], new Set(), { answer: () => undefined });
  expect(working).toMatchObject({ type: "working", items: [{ type: "message", key: "activity", sender: "/root/researcher", title: "completed", details: {}, senderActivityKey: "thread-2" }] });
});

test("sub-agents are background activities: their latest activity says whether they run, and their path nests them", async () => {
  const { codexBackgroundActivities } = await import("../src/server/background.ts");
  const activity = (id: string, kind: "started" | "interacted" | "interrupted" | "completed", thread: string, path: string) => ({ type: "subAgentActivity" as const, id, kind, agentThreadId: thread, agentPath: path });
  const turns = [{
    id: "turn", itemsView: "full" as const, status: "completed" as const, error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: [activity("1", "started", "t-explorer", "/root/explorer"), activity("2", "started", "t-checker", "/root/explorer/checker"), activity("3", "started", "t-planner", "/root/planner"), activity("4", "completed", "t-explorer", "/root/explorer"), activity("5", "interrupted", "t-planner", "/root/planner")],
  }];
  const subagentThreads = new Map([["t-checker", { stopped: false, startedAt: 100_000, answers: new Map() }]]);
  expect(codexBackgroundActivities({ state: { turns }, subagentThreads }).find(activity => activity.key === "t-checker")?.startedAt).toBe(100_000);
  expect(codexBackgroundActivities({ state: { turns }, subagentThreads: new Map([["t-checker", { stopped: true, answers: new Map() }]]) }).find(activity => activity.key === "t-checker")).toMatchObject({ running: false, progress: "Stopped" });
  expect(codexBackgroundActivities({ state: { turns }, subagentThreads: new Map() }).map(({ key, title, running, parentKey, progress, startedBy }) => ({ key, title, running, parentKey, progress, startedBy }))).toEqual([
    { key: "t-explorer", title: "explorer", running: false, parentKey: undefined, progress: undefined, startedBy: { itemKey: "1", label: "Incoming message" } },
    { key: "t-checker", title: "checker", running: true, parentKey: "t-explorer", progress: undefined, startedBy: { itemKey: "2", label: "Incoming message" } },
    { key: "t-planner", title: "planner", running: false, parentKey: undefined, progress: "Stopped", startedBy: { itemKey: "3", label: "Incoming message" } },
  ]);
});

test("a finished sub-agent's message carries its answer, read from its own thread for the turn it names", async () => {
  const { codexSubagentAnswer } = await import("../src/server/background.ts");
  const runtime = { subagentThreads: new Map([["thread-2", { stopped: false, answers: new Map([["turn-a", "First answer."], ["turn-b", "Found three tables."]]) }]]) };
  const [working] = projectCodexTurns([{
    id: "turn", itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: [{ type: "subAgentActivity", id: "subagent-completed-turn-b", kind: "completed", agentThreadId: "thread-2", agentPath: "/root/researcher" }, { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: "thread-2", agentPath: "/root/researcher" }],
  }], new Set(), { answer: activity => codexSubagentAnswer(runtime, activity) });
  expect(working).toMatchObject({ items: [{ bodyMarkdown: "Found three tables." }, { bodyMarkdown: undefined }] });
});

test("an answer belongs to exactly the turn named, and a sub-agent's own transcript doesn't link its sub-agents", async () => {
  const { codexSubagentAnswer } = await import("../src/server/background.ts");
  const runtime = { subagentThreads: new Map([["thread", { stopped: false, answers: new Map([["1", "One."], ["11", "Eleven."]]) }]]) };
  expect(codexSubagentAnswer(runtime, { kind: "completed", id: "subagent-completed-11", agentThreadId: "thread" })).toBe("Eleven.");
  expect(codexSubagentAnswer(runtime, { kind: "completed", id: "call_1", agentThreadId: "thread" })).toBeUndefined();
  const [working] = projectCodexTurns([{
    id: "turn", itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: [{ type: "subAgentActivity", id: "subagent-completed-11", kind: "completed", agentThreadId: "thread", agentPath: "/root/explorer/checker" }],
  }], new Set());
  expect(working).toMatchObject({ items: [{ type: "message", senderActivityKey: undefined, bodyMarkdown: undefined }] });
});

test("a sub-agent sent new work before its turn begins still runs; one whose turn ended early has stopped", async () => {
  const { codexBackgroundActivities } = await import("../src/server/background.ts");
  const turns = [{
    id: "turn", itemsView: "full" as const, status: "completed" as const, error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: [{ type: "subAgentActivity" as const, id: "call_1", kind: "interacted" as const, agentThreadId: "thread", agentPath: "/root/helper" }],
  }];
  expect(codexBackgroundActivities({ state: { turns }, subagentThreads: new Map([["thread", { stopped: false, answers: new Map() }]]) })[0]?.running).toBe(true);
  expect(codexBackgroundActivities({ state: { turns }, subagentThreads: new Map([["thread", { stopped: true, answers: new Map() }]]) })[0]).toMatchObject({ running: false, progress: "Stopped" });
});

test("steering Codex read mid-turn ends the block it interrupted and starts its own, timed only where live notifications timed it", () => {
  const turn: Turn = { id: "turn", itemsView: "full", status: "completed", error: null, startedAt: 10, completedAt: 40, durationMs: 30_000, items: [
    { type: "userMessage", id: "prompt", clientId: "prompt", content: [{ type: "text", text: "Start", text_elements: [] }] },
    { type: "reasoning", id: "command", summary: ["Looking around"], content: [] },
    { type: "userMessage", id: "steer", clientId: "steer", content: [{ type: "text", text: "Instead", text_elements: [] }] },
    { type: "reasoning", id: "thought", summary: ["Changing course"], content: [] },
    { type: "agentMessage", id: "answer", text: "Done", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
  ] };
  const keys = (items: ReturnType<typeof projectCodexTurns>) => items.map(item => item.key);
  const history = projectCodexTurns([turn], new Set());
  expect(keys(history)).toEqual(["prompt", "turn", "steer", "turn:steer", "answer"]);
  expect(history[1]).toMatchObject({ startedAt: 10_000, completedAt: 10_000, durationUnavailable: true, hasFinalAnswer: false, items: [{ key: "command" }] });
  expect(history[3]).toMatchObject({ completedAt: 40_000, durationUnavailable: true, hasFinalAnswer: true, items: [{ key: "thought" }] });
  const live = projectCodexTurns([turn], new Set(), undefined, new Map([["command", 11_000], ["thought", 25_000]]));
  expect(live[1]).toMatchObject({ startedAt: 10_000, completedAt: 25_000 });
  expect(live[1]).not.toHaveProperty("durationUnavailable", true);
  expect(live[3]).toMatchObject({ startedAt: 25_000, completedAt: 40_000 });
  expect(live[3]).not.toHaveProperty("durationUnavailable", true);
});
