import { readFile } from "node:fs/promises";
import type { ToolView, TranscriptItem } from "@agents-in-the-cloud/agent/server/transcript";
import { registerBuiltinAgentIntegration } from "@agents-in-the-cloud/builtin-agent/server";
import { codemodeTranscript } from "../../src/server/transcript.ts";

registerBuiltinAgentIntegration({ id: "codemode-test", transcript: codemodeTranscript });

export function codemodeTool(items: readonly TranscriptItem[]): ToolView | undefined {
  for (const item of items) {
    if (item.type === "tool" && item.tool.name === "codemode") return item.tool;
    const nested = item.type === "working" ? codemodeTool(item.items) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

export async function localScriptFiles(path: string) {
  return await readFile(path, "utf8").then(text => ({ text }), (error: Error) => ({ error: error.message }));
}
