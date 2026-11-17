import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { formatTokens } from "@agents-in-the-cloud/agent/server/transcript";
import { backgroundActivityLinksHtml, backgroundOutputHtml, backgroundScriptFrameHtml, backgroundScriptResponse, backgroundTranscriptHtml, backgroundTranscriptItemResponse, refreshingBackgroundDetail, type BackgroundActivity } from "@agents-in-the-cloud/agent/server/background-activity";
import type { AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import { readClaudeSubagentRows } from "./rows.ts";
import { projectClaudeTranscript } from "./transcript.ts";
import type { ClaudeRuntime, ClaudeTask } from "./runtime.ts";
import { workflowAgentRows, type ClaudeWorkflowAgent, type ClaudeWorkflowProgress } from "./workflow.ts";

const kinds = new Map<string, Pick<BackgroundActivity, "kind" | "opens">>([
  ["local_bash", { kind: "command", opens: "inline" }],
  ["monitor", { kind: "monitor", opens: "inline" }],
  ["local_agent", { kind: "subagent", opens: "drill-in" }],
  ["local_workflow", { kind: "workflow", opens: "drill-in" }],
  ["mcp_task", { kind: "MCP task", opens: "inline" }],
  ["remote_agent", { kind: "remote agent", opens: "inline" }],
]);

function activity(task: ClaudeTask): BackgroundActivity {
  const { kind, opens } = kinds.get(task.type) ?? { kind: task.type, opens: "inline" };
  const details: Record<string, string> = {};
  if (task.subagentType) details.Type = task.subagentType;
  if (task.usage) {
    details["Tool uses"] = String(task.usage.toolUses);
    details.Tokens = formatTokens(task.usage.tokens);
  }
  return {
    key: task.id, kind, opens, details, running: true, stoppable: true,
    title: task.workflowName ?? task.description, startedAt: task.startedAt, parentKey: task.parentTaskId, startedBy: task.toolUseId ? { itemKey: task.toolUseId, label: "Tool call" } : undefined,
    progress: task.type === "local_workflow" ? undefined : task.summary ?? (task.lastToolName ? `Using ${task.lastToolName}` : undefined),
  };
}

const workflowAgentKind = "workflow agent";

const workflowAgentRunning = (agent: ClaudeWorkflowAgent) => agent.state === "start" || agent.state === "progress";

function workflowAgentActivity(workflow: ClaudeTask, agent: ClaudeWorkflowAgent & { agentId: string }): BackgroundActivity {
  const details: Record<string, string> = {};
  if (agent.phaseTitle) details.Phase = agent.phaseTitle;
  if (agent.model) details.Model = agent.model;
  if (agent.toolCalls !== undefined) details["Tool uses"] = String(agent.toolCalls);
  if (agent.tokens !== undefined) details.Tokens = formatTokens(agent.tokens);
  const running = workflowAgentRunning(agent);
  return {
    key: agent.agentId, kind: workflowAgentKind, opens: "drill-in", details, running, stoppable: false,
    title: agent.label, startedAt: agent.startedAt, parentKey: workflow.id, result: agent.state === "done" ? agent.resultPreview : undefined,
    progress: agent.error ?? (running && agent.lastToolName ? [agent.lastToolName, agent.lastToolSummary].filter(Boolean).join(": ") : undefined),
  };
}

const startedWorkflowAgents = (task: ClaudeTask, phase?: string) => (task.workflow?.agents ?? [])
  .filter((agent): agent is ClaudeWorkflowAgent & { agentId: string } => agent.agentId !== undefined && (phase === undefined || agent.phaseTitle === phase))
  .map(agent => workflowAgentActivity(task, agent));

export function claudeBackgroundActivities(runtime: ClaudeRuntime): BackgroundActivity[] {
  return runtime.tasks.filter(task => !task.ambient || task.type === "monitor").flatMap(task => [activity(task), ...startedWorkflowAgents(task)]);
}

async function subagentTranscript(runtime: ClaudeRuntime, activity: BackgroundActivity) {
  const workflowAgent = activity.kind === workflowAgentKind;
  const rows = await readClaudeSubagentRows(runtime.sessions, runtime.record.sessionId, activity.key, workflowAgent);
  return projectClaudeTranscript({ rows: workflowAgent ? workflowAgentRows(rows) : rows }, true);
}

const workflowScript = (runtime: ClaudeRuntime, activity: BackgroundActivity) => runtime.tasks.find(task => task.id === (activity.kind === workflowAgentKind ? activity.parentKey : activity.key))?.script;

function workflowPhasesHtml(ctx: AgentRenderContext, task: ClaudeTask, workflow: ClaudeWorkflowProgress): string {
  return workflow.phases.map(title => {
    const agents = workflow.agents.filter(agent => agent.phaseTitle === title);
    const running = agents.filter(agent => workflowAgentRunning(agent) && agent.agentId).length;
    const queued = agents.filter(agent => agent.state === "start" && !agent.agentId).length;
    const done = agents.filter(agent => agent.state === "done").length;
    const failed = agents.filter(agent => agent.state === "error").length;
    const counts = [running && `${running} running`, queued && `${queued} waiting`, done && `${done} done`, failed && `${failed} failed`].filter(Boolean).join(", ") || "Not started";
    const [state, marker] = failed ? [' data-status="failed"', Icons.Close] : running || queued ? [' aria-busy="true"', ""] : done ? [' role="checkbox" aria-checked="true"', Icons.Check] : ["", ""];
    const item = `<li class="status-list__item"${state}><span class="status-list__marker">${marker}</span>${escapeHtml(title)} <span class="agent-background-meta">· ${counts}</span></li>`;
    return `<section class="agent-workflow-phase"><ul class="status-list status-list--compact">${item}</ul><div class="agent-workflow-phase-agents">${backgroundActivityLinksHtml(ctx, startedWorkflowAgents(task, title))}</div></section>`;
  }).join("");
}

export async function claudeBackgroundDetail(runtime: ClaudeRuntime, activity: BackgroundActivity, ctx: AgentRenderContext): Promise<string> {
  const task = runtime.tasks.find(task => task.id === activity.key);
  if (activity.kind === workflowAgentKind || task?.type === "local_agent") {
    const script = workflowScript(runtime, activity) ? backgroundScriptFrameHtml(ctx, activity) : "";
    return refreshingBackgroundDetail(activity, script + backgroundTranscriptHtml(ctx, activity, await subagentTranscript(runtime, activity)));
  }
  if (!task) throw new Error(`No background task ${activity.key}`);
  if (task.type === "local_workflow") return refreshingBackgroundDetail(activity, `${task.workflow ? workflowPhasesHtml(ctx, task, task.workflow) : ""}${task.script ? backgroundScriptFrameHtml(ctx, activity) : ""}`);
  if (task.type === "local_bash" || task.type === "monitor") {
    const output = await runtime.taskOutput(task.id);
    return refreshingBackgroundDetail(activity, backgroundOutputHtml(output.output, output.truncated ? "Output · the last part" : "Output"));
  }
  return "";
}

export async function claudeBackgroundRoute(runtime: ClaudeRuntime, activity: BackgroundActivity, path: string, url: URL, ctx: AgentRenderContext): Promise<Response | undefined> {
  const script = workflowScript(runtime, activity);
  if (path === "script" && script) return backgroundScriptResponse(ctx, activity, script, activity.kind === workflowAgentKind ? "Workflow script" : undefined);
  return activity.opens === "drill-in" && activity.kind !== "workflow" ? backgroundTranscriptItemResponse(ctx, activity, path, url, () => subagentTranscript(runtime, activity)) : undefined;
}
