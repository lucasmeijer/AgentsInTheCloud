import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "@agents-in-the-cloud/core";
import { contentText } from "@earendil-works/pi-ai";
import { migrateSessionEntries, type FileEntry } from "@earendil-works/pi-coding-agent";
import { AssistantEntry, UserEntry, ToolResultEntry, type EntryDraft, type ConversationId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { historyNote } from "./entries.ts";

export interface ConvertedAgent {
  agentId: string;
  label: string;
  title: string;
  storage: "durable";
}

/** The destination must atomically import read-only entries and their identity.
 * Existing identities must return their original ID without appending entries.
 */
export interface HistoryImportDestination {
  catalog(): Promise<readonly { agentId: string }[]>;
  importHistory(identity: Pick<ConvertedAgent, "agentId" | "label" | "title">, entries: readonly EntryDraft[]): Promise<ConversationId>;
}

export interface LegacyConversion {
  workspaceId: string;
  workspaceDirectory: string;
  shareDirectory: string;
  metadata: string | undefined;
  destination(): Promise<HistoryImportDestination>;
}

const oldMetadata = Type.Object({ conversations: Type.Array(Type.Object({
  conversationId: Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }), label: Type.String(), title: Type.String(),
  storage: Type.Optional(Type.Literal("durable")),
})) });
const oldFilename = /^(?:builtin--)?([a-z0-9][a-z0-9-]*)--([a-zA-Z0-9][a-zA-Z0-9_.-]*)--agent-([1-9]\d*)--([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/;
const envelope = Type.Object({ type: Type.String() });
const entryIdentity = Type.Object({ id: Type.String(), parentId: Type.Union([Type.String(), Type.Null()]) });
const content = Type.Union([Type.String(), Type.Array(Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
  Type.Object({ type: Type.Literal("thinking"), thinking: Type.String() }),
  Type.Object({ type: Type.Literal("toolCall"), id: Type.String(), name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
]))]);
const messageSchema = Type.Object({ role: Type.String(), content });

async function transcript(path: string): Promise<EntryDraft[]> {
  const parsed = (await readFile(path, "utf8")).split("\n").filter(line => line.trim()).map(line => Value.Parse(envelope, JSON.parse(line)));
  // SAFETY: Only the envelope is needed by the SDK's in-memory version migration;
  // entry identities and display payloads are validated below before conversion.
  const entries = parsed as FileEntry[];
  const header = entries.find(entry => entry.type === "session");
  if (header?.version !== undefined && ![1, 2, 3].includes(header.version)) throw new Error(`Unsupported legacy session version in ${path}`);
  migrateSessionEntries(entries);
  const byId = new Map<string, Exclude<FileEntry, { type: "session" }>>();
  for (const entry of entries) {
    if (entry.type === "session") continue;
    Value.Assert(entryIdentity, entry);
    if (byId.has(entry.id)) throw new Error(`Duplicate legacy entry ID in ${path}: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  const branch: Exclude<FileEntry, { type: "session" }>[] = [];
  const visited = new Set<string>();
  let id = [...byId.keys()].at(-1);
  while (id !== undefined) {
    if (visited.has(id)) throw new Error(`Cycle in legacy history: ${path}`);
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`Missing legacy parent ${id} in ${path}`);
    branch.push(entry);
    id = entry.parentId ?? undefined;
  }
  const result: EntryDraft[] = [{ kind: historyNote.kind, data: { text: "Imported read-only history. Only the selected branch was imported; original files are unchanged. Historical usage and timing are unavailable.", tone: "system" } }];
  for (const entry of branch.reverse()) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
        Value.Assert(messageSchema, message);
        if (message.role === "assistant" && !Array.isArray(message.content)) throw new Error(`Invalid assistant content in ${path}`);
        if (message.role === "toolResult") Value.Assert(Type.Object({ toolCallId: Type.String(), toolName: Type.String() }), message);
        result.push({ kind: message.role === "user" ? UserEntry.kind : message.role === "assistant" ? AssistantEntry.kind : ToolResultEntry.kind, model: [message] });
        continue;
      }
    }
    let text: string | undefined;
    if (entry.type === "compaction" || entry.type === "branch_summary") text = entry.summary;
    else if (entry.type === "custom_message" && entry.display) text = contentText(entry.content);
    else if (entry.type === "message" && entry.message.role === "bashExecution") text = `$ ${entry.message.command}\n\n${entry.message.output}`;
    else if (entry.type === "message" && entry.message.role === "branchSummary") text = entry.message.summary;
    else if (entry.type === "message" && entry.message.role === "custom" && entry.message.display) text = contentText(entry.message.content);
    else if (entry.type === "model_change") text = `Model → ${entry.provider}/${entry.modelId}`;
    else if (entry.type === "thinking_level_change") text = `Thinking level → ${entry.thinkingLevel}`;
    if (text !== undefined) {
      Value.Assert(Type.String(), text);
      result.push({ kind: historyNote.kind, data: { text, tone: "summary" } });
    }
  }
  return result;
}

/** Called once per old metadata file, under the conversation store's workspace queue.
 * Journal import precedes metadata replacement. The catalog UUID is the retry marker;
 * a crash in that gap reuses the committed import even if the source is now absent.
 */
export async function convertLegacyAgents(options: LegacyConversion): Promise<ConvertedAgent[]> {
  const { workspaceId, metadata, shareDirectory: directory } = options;
  const records = metadata === undefined ? [] : Value.Parse(oldMetadata, JSON.parse(metadata)).conversations;
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  const sources = new Map(records.filter(record => !record.storage).map(record => [record.conversationId, {
    ...record, path: join(options.workspaceDirectory, "agent-sessions", `${record.conversationId}.jsonl`),
  }]));
  for (const name of files) {
    const match = name.match(oldFilename);
    if (!match || match[2] !== workspaceId || records.some(record => record.conversationId === match[4]) || sources.has(match[4]!)) continue;
    const record = { conversationId: match[4]!, label: `Agent ${Number(match[3])}`, title: (await readFile(join(directory, name.replace(/\.jsonl$/, ".title")), "utf8")).trim() };
    records.push(record);
    sources.set(record.conversationId, { ...record, path: join(directory, name) });
  }
  if (sources.size) {
    const owner = await options.destination();
    const catalog = await owner.catalog();
    for (const source of sources.values()) {
      if (!catalog.some(record => record.agentId === source.conversationId)) {
        await owner.importHistory({ agentId: source.conversationId, label: source.label, title: source.title }, await transcript(source.path));
      }
    }
  }
  return records.map(record => ({ agentId: record.conversationId, label: record.label, title: record.title, storage: "durable" }));
}
