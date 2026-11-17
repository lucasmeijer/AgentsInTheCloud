import { expect, test } from "bun:test";
import { backgroundOutputHtml, backgroundReportHtml, refreshingBackgroundDetail, renderBackgroundActivities, renderBackgroundInlineDetail, renderBackgroundPage, type BackgroundActivity } from "../../src/server/background-activity.ts";
import type { AgentRenderContext } from "../../src/server/render-context.ts";

const ctx: AgentRenderContext = { workspaceId: "ws", agentId: "agent", transcriptBasePath: "/workspaces/ws/claude-code-agents/agent" };
const activity = (key: string, overrides: Partial<BackgroundActivity> = {}): BackgroundActivity => ({ key, kind: "subagent", title: key, running: true, details: {}, stoppable: true, opens: "drill-in", ...overrides });

test("the bar lists running work before idle work, each followed by the work it started", () => {
  const html = renderBackgroundActivities(ctx, [
    activity("reviewer", { running: false }),
    activity("checker", { parentKey: "writer" }),
    activity("writer"),
    activity("suite", { kind: "command", opens: "inline" }),
  ]);
  expect([...html.matchAll(/data-background-key="([^"]+)"/g)].map(match => match[1])).toEqual(["writer", "checker", "suite", "reviewer"]);
  expect(html).toContain('3 running <span class="status-indicator"');
  expect(html).toContain("· 1 inactive");
  expect(html).toContain('style="--agent-background-depth: 1" data-background-key="checker"');
  expect(html.match(/status-spinner/g)?.length).toBe(4);
  expect(html).not.toContain("subagent");
  expect(html).toContain('href="/workspaces/ws/claude-code-agents/agent/background/writer" data-action="agent-background#open"');
  expect(html).toContain('src="/workspaces/ws/claude-code-agents/agent/background/suite" loading="lazy"');
  expect(html).not.toContain("Stop");
  expect(renderBackgroundActivities(ctx, [])).toBe("");
});

test("Stop and the facts show once an activity is opened, and detail read on request keeps itself current while running", () => {
  const command = activity("suite", { kind: "command", opens: "inline", startedBy: { itemKey: "toolu_1", label: "Tool call" }, details: { Type: "shell" } });
  const inline = renderBackgroundInlineDetail(ctx, command, refreshingBackgroundDetail(command, backgroundOutputHtml("tick 1", "Output · the last part")));
  expect(inline).toContain('action="/workspaces/ws/claude-code-agents/agent/background/suite/stop"');
  expect(inline).toContain('class="destructive-confirmation"');
  expect(inline).toContain(">Stop command</span>");
  expect(inline).toContain("Keep running");
  expect(inline).toContain("<dt>Started by</dt>");
  expect(inline).toContain("Output · the last part");
  expect(inline).toContain('data-controller="agent-background-refresh"');
  const page = renderBackgroundPage(ctx, activity("writer", { running: false, startedBy: { itemKey: "toolu_2", label: "Tool call" } }), "<p>Write the migration</p>");
  expect(page).toContain("<dt>Kind</dt><dd>subagent</dd>");
  expect(page).toContain("<dt>Started by</dt><dd><a href=");
  expect(page).not.toContain("status-spinner");
  expect(page).toContain('data-action="agent-background#back"');
  expect(page).toContain("Write the migration");
  expect(page).not.toContain("agent-background-refresh");
  expect(page).not.toContain("/stop");
  expect(backgroundReportHtml(ctx, "answer")).toContain('href="/workspaces/ws?agent=agent&amp;agentTarget=answer"');
});
