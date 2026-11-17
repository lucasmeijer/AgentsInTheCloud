import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentsInTheCloudRuntimeContext, isNotFoundError, readTextIfExists } from "@agents-in-the-cloud/core";
import { nativeImageTypes, nativeJsonlRows, nativeTimestamp } from "@agents-in-the-cloud/cli-agent/server";
import type { SessionImageRef } from "@agents-in-the-cloud/agent/server/transcript";
import { workspaceRoot } from "@agents-in-the-cloud/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const sourceSchema = Type.Object({ type: Type.String(), media_type: Type.Optional(Type.String()), data: Type.Optional(Type.String()) });
const resultBlockSchema = Type.Object({ type: Type.String(), text: Type.Optional(Type.String()), source: Type.Optional(sourceSchema) });
const blockSchema = Type.Object({
  type: Type.String(), text: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), source: Type.Optional(sourceSchema),
  id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), input: Type.Optional(Type.Unknown()),
  tool_use_id: Type.Optional(Type.String()), is_error: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.Union([Type.String(), Type.Array(resultBlockSchema)])),
});
const usageSchema = Type.Object({
  input_tokens: Type.Number(), output_tokens: Type.Number(),
  cache_creation_input_tokens: Type.Optional(Type.Union([Type.Number(), Type.Null()])), cache_read_input_tokens: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
const rowSchema = Type.Object({
  type: Type.String(), subtype: Type.Optional(Type.String()), uuid: Type.Optional(Type.String()), timestamp: Type.Optional(Type.String()),
  isSidechain: Type.Optional(Type.Boolean()), isMeta: Type.Optional(Type.Boolean()), isCompactSummary: Type.Optional(Type.Boolean()), isApiErrorMessage: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.Unknown()),
  origin: Type.Optional(Type.Object({ runId: Type.Optional(Type.String()) })),
  message: Type.Optional(Type.Object({
    id: Type.Optional(Type.String()), content: Type.Union([Type.String(), Type.Array(blockSchema)]),
    stop_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])), usage: Type.Optional(usageSchema),
  })),
  attachment: Type.Optional(Type.Object({ type: Type.String(), prompt: Type.Optional(Type.Union([Type.String(), Type.Array(blockSchema)])), source_uuid: Type.Optional(Type.String()), runId: Type.Optional(Type.String()) })),
  customTitle: Type.Optional(Type.String()), aiTitle: Type.Optional(Type.String()),
});
const commandOutputSchema = Type.Object({ type: Type.Literal("system"), subtype: Type.Literal("local_command"), uuid: Type.String(), content: Type.String() });
export type ClaudeBlock = Static<typeof blockSchema>;
export function claudeBlocks(content: string | object[]): ClaudeBlock[] {
  return Array.isArray(content) ? content.filter(block => Value.Check(blockSchema, block)) : [{ type: "text", text: content }];
}

export type ClaudeRow =
  | { kind: "user"; uuid: string; timestamp: number; content: ClaudeBlock[]; meta: boolean }
  | { kind: "assistant"; uuid: string; timestamp: number; messageId: string; content: ClaudeBlock[]; stopReason: string | null; usage?: Static<typeof usageSchema>; error: boolean }
  | { kind: "steer"; uuid: string; timestamp: number; content: ClaudeBlock[] }
  | { kind: "task"; uuid: string; timestamp: number; runId: string; toolUseId?: string; status: string; summary: string; result?: string; usage?: ClaudeTaskUsage }
  | { kind: "compact"; uuid: string; timestamp: number }
  | { kind: "output"; uuid: string; timestamp: number; text: string; error: boolean };

export interface ClaudeTaskUsage { tokens: number; toolUses: number; durationMs: number }

export function claudeRows(jsonl: string, sidechain = false): ClaudeRow[] {
  const rows: ClaudeRow[] = [];
  for (const row of nativeJsonlRows(jsonl, rowSchema)) {
    if ((row.isSidechain === true) !== sidechain) continue;
    const timestamp = nativeTimestamp(row.timestamp);
    if (row.type === "attachment" && row.attachment?.type === "queued_command" && row.uuid) {
      const content = claudeBlocks(row.attachment.prompt ?? "");
      rows.push(taskRow(row.uuid, timestamp, claudeText(content), row.attachment.runId) ?? { kind: "steer", uuid: row.attachment.source_uuid ?? row.uuid, timestamp, content });
    } else if (Value.Check(commandOutputSchema, row)) {
      const output = commandOutput(row.content);
      if (output) rows.push({ kind: "output", uuid: row.uuid, timestamp, ...output });
    } else if (!row.uuid || !row.message) {
      if (row.type === "system" && row.subtype === "compact_boundary" && row.uuid) rows.push({ kind: "compact", uuid: row.uuid, timestamp });
    } else if (row.type === "user") {
      const content = claudeBlocks(row.message.content);
      const output = row.isMeta === true ? undefined : commandOutput(claudeText(content));
      rows.push(output ? { kind: "output", uuid: row.uuid, timestamp, ...output } : taskRow(row.uuid, timestamp, claudeText(content), row.origin?.runId) ?? { kind: "user", uuid: row.uuid, timestamp, content, meta: row.isMeta === true || row.isCompactSummary === true });
    } else if (row.type === "assistant") {
      rows.push({ kind: "assistant", uuid: row.uuid, timestamp, messageId: row.message.id ?? row.uuid, content: claudeBlocks(row.message.content), stopReason: row.message.stop_reason ?? null, usage: row.message.usage, error: row.isApiErrorMessage === true });
    }
  }
  return rows;
}

function taskRow(uuid: string, timestamp: number, text: string, runId: string | undefined): ClaudeRow | undefined {
  const value = text.trim();
  if (!value.startsWith("<task-notification>")) return undefined;
  const usage = tag(value, "usage");
  const count = (name: string) => Number(tag(usage!, name) ?? 0);
  return {
    kind: "task", uuid, timestamp, runId: runId ?? uuid, toolUseId: tag(value, "tool-use-id"), status: tag(value, "status") ?? "completed",
    summary: tag(value, "summary")?.trim() ?? "", result: tag(value, "result")?.trim() || undefined,
    usage: usage ? { tokens: count("subagent_tokens"), toolUses: count("tool_uses"), durationMs: count("duration_ms") } : undefined,
  };
}

export function claudeSessionDirectory(workspaceId: string, agentId: string): string {
  return join(getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "workspaces", workspaceId, "home-local", ".local", "share", "agents-in-the-cloud-agents", agentId, "claude", "projects", workspaceRoot.replaceAll("/", "-"));
}

export async function readClaudeRows(directory: string, sessionId: string): Promise<ClaudeRow[] | undefined> {
  const text = await readTextIfExists(join(directory, `${sessionId}.jsonl`));
  return text === undefined ? undefined : claudeRows(text);
}

export async function readClaudeSubagentRows(directory: string, sessionId: string, agentId: string, inWorkflow = false): Promise<ClaudeRow[]> {
  const subagents = join(directory, sessionId, "subagents");
  const path = inWorkflow ? await workflowAgentPath(subagents, agentId) : join(subagents, `agent-${agentId}.jsonl`);
  if (!path) return [];
  const file = await stat(path).catch(error => { if (isNotFoundError(error)) return undefined; throw error; });
  if (!file) return [];
  const version = `${file.size}:${file.mtimeMs}`;
  const cached = subagentRows.get(path);
  if (cached?.version === version) return cached.rows;
  const rows = claudeRows(await readTextIfExists(path) ?? "", true);
  subagentRows.set(path, { version, rows });
  return rows;
}
const subagentRows = new Map<string, { version: string; rows: ClaudeRow[] }>();

async function workflowAgentPath(subagents: string, agentId: string): Promise<string | undefined> {
  const workflows = join(subagents, "workflows");
  const runs = await readdir(workflows).catch(error => { if (isNotFoundError(error)) return []; throw error; });
  for (const run of runs) {
    const path = join(workflows, run, `agent-${agentId}.jsonl`);
    if (await Bun.file(path).exists()) return path;
  }
  return undefined;
}

export async function hasClaudeSession(directory: string, sessionId: string): Promise<boolean> {
  return Bun.file(join(directory, `${sessionId}.jsonl`)).exists();
}

export interface ClaudeSessionSummary { id: string; title: string; updatedAt: number }

export async function listClaudeSessions(directory: string, limit: number): Promise<ClaudeSessionSummary[]> {
  let names: string[];
  try { names = (await readdir(directory)).filter(name => name.endsWith(".jsonl")); }
  catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const files = await Promise.all(names.map(async name => ({ id: name.slice(0, -".jsonl".length), updatedAt: (await stat(join(directory, name))).mtimeMs })));
  const recent = files.toSorted((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
  const sessions = await Promise.all(recent.map(async file => {
    const text = await readTextIfExists(join(directory, `${file.id}.jsonl`)) ?? "";
    let title = "";
    let prompt = "";
    for (const row of nativeJsonlRows(text, rowSchema)) {
      title = row.customTitle ?? row.aiTitle ?? title;
      if (!prompt && row.type === "user" && row.isMeta !== true && row.isSidechain !== true && row.message) prompt = claudeText(claudeBlocks(row.message.content)).trim();
    }
    return { id: file.id, title: title || prompt.split("\n")[0]!.slice(0, 120), updatedAt: file.updatedAt };
  }));
  return sessions.filter(session => session.title);
}

const interruption = /^\[Request interrupted by user[^\]]*\]$/;
const internalMessages = new Set(["local-command-caveat", "system-reminder"]);

export function claudeImageSources(content: ClaudeBlock[]): Array<{ media_type: string; data: string }> {
  return content.flatMap(block => [block, ...Array.isArray(block.content) ? block.content : []]).flatMap(block => {
    const source = block.type === "image" ? block.source : undefined;
    return source?.type === "base64" && source.media_type && source.data && nativeImageTypes.has(source.media_type) ? [{ media_type: source.media_type, data: source.data }] : [];
  });
}

export function claudeText(content: ClaudeBlock[]): string {
  return content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

function tag(value: string, name: string): string | undefined {
  return value.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
}

const controlCommands = new Set(["/model"]);

function commandOutput(text: string): { text: string; error: boolean } | undefined {
  const value = text.trim();
  const leading = value.match(/^<(local-command-stdout|local-command-stderr)>/)?.[1];
  const output = leading ? tag(value, leading)?.trim() : undefined;
  return output ? { text: output, error: leading === "local-command-stderr" } : undefined;
}

export function claudeUserIntent(row: Extract<ClaudeRow, { kind: "user" }>): { kind: "prompt"; text: string; images: SessionImageRef[] } | { kind: "control" | "interrupted"; text?: never } | undefined {
  if (row.meta || row.content.some(block => block.type === "tool_result")) return undefined;
  const value = claudeText(row.content).trim();
  if (interruption.test(value)) return { kind: "interrupted" };
  const leading = value.match(/^<([a-z-]+)>/)?.[1];
  if (leading && internalMessages.has(leading)) return undefined;
  const images = claudeImageSources(row.content).map((source, contentIndex) => ({ entryId: row.uuid, contentIndex, mimeType: source.media_type }));
  const command = leading === "command-name" || leading === "command-message" ? tag(value, "command-name") : undefined;
  if (command && controlCommands.has(command)) return { kind: "control" };
  if (command) return { kind: "prompt", text: [command, tag(value, "command-args")?.trim()].filter(Boolean).join(" "), images };
  return value || images.length ? { kind: "prompt", text: value, images } : undefined;
}

