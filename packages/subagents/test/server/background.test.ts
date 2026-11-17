import { expect, test } from "bun:test";
import { subagentActivities } from "../../src/server/background.ts";
import type { Receipt } from "../../src/server/native-state.ts";

type Message = Pick<Receipt, "id" | "from" | "to" | "kind" | "callId">;
const task = (from: string, to: string, callId: string): Message => ({ id: callId, from, to, kind: "task", callId });
const answer = (id: string, from: string, to: string): Message => ({ id, from, to, kind: "completion" });

test("an Agent's subagents nest under the one that started them; closed ones leave, finished ones stay inactive", () => {
  const agent = (id: string, parentId: string, status: string, taskName = id) => ({ id, parentId, rootId: "root", taskName, status, task: `Task for ${id}` });
  const activities = subagentActivities({
    agents: [agent("writer", "root", "running"), agent("checker", "writer", "pending"), agent("researcher", "root", "completed"), agent("old", "root", "closed"), agent("auditor", "root", "interrupted"), { ...agent("other", "elsewhere", "running"), rootId: "elsewhere" }],
    messages: [
      task("root", "writer", "call_spawn"), task("root", "researcher", "call_spawn_r"), answer("first-answer", "researcher", "root"), task("root", "researcher", "call_followup"), answer("second-answer", "researcher", "root"),
      task("writer", "checker", "call_nested"), answer("nested-answer", "checker", "writer"), task("root", "auditor", "call_audit"), answer("audit-answer", "auditor", "root"), task("root", "auditor", "call_reaudit"),
    ],
  }, "root");
  expect(activities.map(({ key, running, parentKey, progress, startedBy, details }) => ({ key, running, parentKey, progress, startedBy: startedBy?.itemKey, task: details.Task }))).toEqual([
    { key: "writer", running: true, parentKey: undefined, progress: undefined, startedBy: "call_spawn", task: "Task for writer" },
    { key: "checker", running: true, parentKey: "writer", progress: "Waiting to start", startedBy: undefined, task: "Task for checker" },
    { key: "researcher", running: false, parentKey: undefined, progress: undefined, startedBy: "call_followup", task: "Task for researcher" },
    { key: "auditor", running: false, parentKey: undefined, progress: "Stopped", startedBy: "call_reaudit", task: "Task for auditor" },
  ]);
});
