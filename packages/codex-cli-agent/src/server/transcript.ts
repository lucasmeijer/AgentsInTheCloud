import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { getAgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import { loadNativeTranscriptFiles, loadNativeTranscriptImage, nativeImageTypes, nativeJsonlRows, nativeSessionFiles, nativeTimestamp } from "@agents-in-the-cloud/cli-agent/server";
import type { TranscriptRecord } from "@agents-in-the-cloud/agent/server/transcript";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const partSchema = Type.Object({ type: Type.String(), text: Type.Optional(Type.String()), image_url: Type.Optional(Type.String()) });
const payloadSchema = Type.Object({
  type: Type.String(), id: Type.Optional(Type.String()), role: Type.Optional(Type.String()),
  content: Type.Optional(Type.Array(partSchema)), summary: Type.Optional(Type.Array(partSchema)),
  name: Type.Optional(Type.String()), arguments: Type.Optional(Type.String()), input: Type.Optional(Type.String()),
  call_id: Type.Optional(Type.String()), output: Type.Optional(Type.Union([Type.String(), Type.Array(partSchema)])),
  status: Type.Optional(Type.String()), phase: Type.Optional(Type.String()),
});
const rowSchema = Type.Object({ type: Type.String(), timestamp: Type.Optional(Type.String()), payload: payloadSchema });
const commandResultSchema = Type.Object({ output: Type.String(), exit_code: Type.Number(), stderr: Type.Optional(Type.String()) });
type Part = Static<typeof partSchema>;

function image(part: Part | undefined): { mimeType: string; data: string } | undefined {
  if (!part || part.type !== "input_image" || !part.image_url) return undefined;
  const match = /^data:(image\/[a-z+.-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(part.image_url);
  if (!match || !nativeImageTypes.has(match[1]!)) return undefined;
  return { mimeType: match[1]!, data: match[2]! };
}
function text(parts: Part[] | undefined): string {
  return (parts ?? []).filter((part) => part.type === "input_text" || part.type === "output_text" || part.type === "summary_text").map((part) => part.text ?? "").filter(Boolean).join("\n");
}
const execArgsSchema = Type.Object({ cmd: Type.String() });
function args(value: string | undefined): string | Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (Value.Check(execArgsSchema, parsed)) return { ...parsed, command: parsed.cmd };
    if (Value.Check(Type.Record(Type.String(), Type.String()), parsed)) return parsed;
    return value;
  } catch { return value; }
}
function toolName(name: string): string {
  return name === "exec_command" || name === "shell_command" ? "bash" : name;
}
/** The Codex exec tool runs JavaScript. Split out only a leading, literal
 * exec_command invocation; any remaining JavaScript keeps its own tool card. */
function execWrapper(input: string | undefined): { command: string; rest: string } | undefined {
  const match = /^\s*text\(await tools\.exec_command\(\{\s*cmd:\s*("(?:\\.|[^"\\])*")[\s\S]*?\}\)\);/.exec(input ?? "");
  if (!match) return undefined;
  try { return { command: JSON.parse(match[1]!), rest: input!.slice(match[0].length).trim() }; }
  catch { return undefined; }
}
function execWrapperResult(output: string | Part[] | undefined): { text: string; isError: boolean; index: number } | undefined {
  if (!Array.isArray(output)) return undefined;
  for (const [index, part] of output.entries()) {
    if (!part.text) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(part.text); } catch { continue; }
    if (Value.Check(commandResultSchema, parsed)) return { text: [parsed.output, parsed.stderr].filter(Boolean).join("\n"), isError: parsed.exit_code !== 0, index };
  }
  return undefined;
}
/** Project Codex's native rollout records without importing them into a mutable Pi session. */
export function codexTranscriptRecords(jsonl: string, fallbackPrefix = "codex"): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  let index = 0;
  const wrappers = new Map<string, string>();
  for (const row of nativeJsonlRows(jsonl, rowSchema)) {
    if (row.type !== "response_item") continue; // event_msg duplicates response items
    const p = row.payload;
    const id = p.id ?? `${fallbackPrefix}-${index++}`;
    const timestamp = nativeTimestamp(row.timestamp);
    if (p.type === "message" && p.role === "user") {
      const images = (p.content ?? []).flatMap((part, contentIndex) => {
        const source = image(part);
        return source ? [{ entryId: id, contentIndex, mimeType: source.mimeType }] : [];
      });
      records.push({ kind: "user", id, text: text(p.content), images, timestamp, rewindable: false });
    } else if (p.type === "message" && p.role === "assistant") {
      const value = text(p.content);
      if (value) records.push({ kind: "assistant", id, parts: [{ type: "text", text: value }], stopReason: p.phase === "commentary" ? "toolUse" : "stop", timestamp });
    } else if (p.type === "reasoning") {
      const value = text(p.summary);
      if (value) records.push({ kind: "assistant", id, parts: [{ type: "thinking", text: value }], stopReason: "toolUse", timestamp });
    } else if ((p.type === "function_call" || p.type === "custom_tool_call") && p.call_id && p.name) {
      const wrapper = p.name === "exec" ? execWrapper(p.input) : undefined;
      if (wrapper) wrappers.set(p.call_id, wrapper.rest);
      const input = wrapper ? { command: wrapper.command } : p.name === "exec" ? { code: p.input ?? "" } : args(p.arguments ?? p.input);
      const parts: Extract<TranscriptRecord, { kind: "assistant" }>["parts"] = [{ type: "toolCall", callId: p.call_id, name: wrapper ? "bash" : toolName(p.name), args: input }];
      if (wrapper?.rest) parts.push({ type: "toolCall", callId: `${p.call_id}:rest`, name: "exec", args: { code: wrapper.rest } });
      records.push({ kind: "assistant", id, parts, stopReason: "toolUse", timestamp });
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && p.call_id) {
      const rest = wrappers.get(p.call_id);
      const shell = rest !== undefined ? execWrapperResult(p.output) : undefined;
      records.push({ kind: "toolResult", callId: p.call_id, text: shell?.text ?? (Value.Check(Type.String(), p.output) ? p.output : text(p.output)), images: [], isError: shell?.isError ?? p.status === "failed", timestamp });
      if (rest && Array.isArray(p.output)) {
        records.push({ kind: "toolResult", callId: `${p.call_id}:rest`, text: text(p.output.slice((shell?.index ?? 0) + 1)), images: [], isError: p.status === "failed", timestamp });
      }
    }
  }
  return records;
}

function sessionDirectory(workspaceId: string, sessionId: string): string {
  return join(getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "workspaces", workspaceId, "home-local", ".local", "share", "agents-in-the-cloud-agents", sessionId, "codex", "sessions");
}
export async function codexHistoryFiles(workspaceId: string, sessionId: string): Promise<string[]> {
  const directory = sessionDirectory(workspaceId, sessionId);
  const metadata = Bun.file(join(directory, "..", "native-session.json"));
  // Older saved tabs kept rollouts inside their private CODEX_HOME.
  if (!await metadata.exists()) return nativeSessionFiles(directory);
  const schema = Type.Object({ id: Type.String(), transcript: Type.String(), private: Type.Optional(Type.Boolean()) });
  const session = Value.Parse(schema, await metadata.json());
  if (isAbsolute(session.transcript) || session.transcript.split("/").includes("..")) throw new Error("Invalid Codex transcript path");
  const root = session.private ? directory : join(getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "home", ".codex", "sessions");
  const file = join(root, session.transcript);
  return await Bun.file(file).exists() ? [file] : [];
}
export async function loadCodexTranscript(workspaceId: string, sessionId: string): Promise<TranscriptRecord[] | undefined> {
  return loadNativeTranscriptFiles(await codexHistoryFiles(workspaceId, sessionId), (jsonl, file) => codexTranscriptRecords(jsonl, basename(file, ".jsonl")));
}
export async function loadCodexTranscriptImage(workspaceId: string, sessionId: string, entryId: string, contentIndex: number): Promise<Response> {
  return loadNativeTranscriptImage(await codexHistoryFiles(workspaceId, sessionId), (jsonl, file) => {
    let index = 0;
    for (const row of nativeJsonlRows(jsonl, rowSchema)) {
      if (row.type !== "response_item") continue;
      const id = row.payload.id ?? `${basename(file, ".jsonl")}-${index++}`;
      if (id !== entryId || row.payload.type !== "message" || row.payload.role !== "user") continue;
      const source = image(row.payload.content?.[contentIndex]);
      if (source) return source;
    }
    return undefined;
  });
}

/** Read the native ID from the tab-private rollout, never use workspace-wide --last. */
export async function codexResumeId(workspaceId: string, sessionId: string): Promise<string | undefined> {
  const file = (await codexHistoryFiles(workspaceId, sessionId)).at(-1);
  if (!file) return undefined;
  const schema = Type.Object({ type: Type.Literal("session_meta"), payload: Type.Object({ id: Type.String() }) });
  const id = Array.from(nativeJsonlRows(await readFile(file, "utf8"), schema))[0]?.payload.id;
  if (!id) throw new Error(`Codex rollout has no native session ID: ${file}`);
  return id;
}
