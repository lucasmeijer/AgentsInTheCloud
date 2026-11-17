import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { claudeText, type ClaudeRow } from "./rows.ts";

const phaseSchema = Type.Object({ type: Type.Literal("workflow_phase"), title: Type.String() });
const agentSchema = Type.Object({
  type: Type.Literal("workflow_agent"), label: Type.String(), phaseTitle: Type.Optional(Type.String()),
  state: Type.String(),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), startedAt: Type.Optional(Type.Number()),
  lastToolName: Type.Optional(Type.String()), lastToolSummary: Type.Optional(Type.String()),
  tokens: Type.Optional(Type.Number()), toolCalls: Type.Optional(Type.Number()), error: Type.Optional(Type.String()),
  resultPreview: Type.Optional(Type.String()),
});

export type ClaudeWorkflowAgent = Omit<Static<typeof agentSchema>, "type">;
export interface ClaudeWorkflowProgress { phases: string[]; agents: ClaudeWorkflowAgent[] }

export const workflowProgressSchema = Type.Array(Type.Object({ type: Type.String() }));

export function workflowProgress(entries: Static<typeof workflowProgressSchema>): ClaudeWorkflowProgress {
  return {
    phases: entries.filter(entry => entry.type === "workflow_phase").map(entry => Value.Parse(phaseSchema, entry).title),
    agents: entries.filter(entry => entry.type === "workflow_agent").map(entry => {
      const { type: _, ...agent } = Value.Parse(agentSchema, entry);
      return agent;
    }),
  };
}

const harnessFrame = /^\[Workflow harness — (user request|computed task)\][^\n]*\n/;

/**
 * A workflow agent's transcript as people read it: its task as its prompt. The request that started the workflow
 * is left out; it is in the conversation that started it.
 */
export function workflowAgentRows(rows: ClaudeRow[]): ClaudeRow[] {
  return rows.flatMap((row): ClaudeRow[] => {
    if (row.kind !== "user") return [row];
    const text = claudeText(row.content);
    const frame = text.match(harnessFrame);
    if (!frame) return [row];
    if (frame[1] === "user request") return [];
    const task = text.slice(frame[0].length).split("\n").map(line => line.replace(/^ {2}/, "")).join("\n");
    return [{ ...row, content: [{ type: "text", text: task }] }];
  });
}
