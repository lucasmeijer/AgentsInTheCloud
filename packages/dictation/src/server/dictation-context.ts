import { readTextIfExists } from "@agents-in-the-cloud/core";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const realtimeEventSchema = Type.Object({ type: Type.String(), session: Type.Optional(Type.Unknown()) }, { additionalProperties: true });
const sessionSchema = Type.Record(Type.String(), Type.Unknown());

export async function readDictationContext(workspaceRoot: string): Promise<string[]> {
  const directory = join(workspaceRoot, ".agents-in-the-cloud");
  const contents = await readTextIfExists(join(directory, "dictation-context"))
    ?? await readTextIfExists(join(directory, "transcription-context")) ?? "";
  return contents.split(/\r?\n/).map((line) => line.split("#", 1)[0]!.trim()).filter(Boolean);
}

export function addTranscriptionContext(message: string, phrases: string[]): string {
  if (!phrases.length) return message;
  const event = Value.Parse(realtimeEventSchema, JSON.parse(message));
  if (event.type !== "session.update") return message;
  const session = Value.Parse(sessionSchema, event.session);
  return JSON.stringify({ ...event, session: { ...session, speech_contexts: [{ phrases, boost: 3 }] } });
}
