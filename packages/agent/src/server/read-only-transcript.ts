import type { AgentRenderContext } from "./render-context.ts";
import { renderTranscriptItem, renderTranscriptItemDetailFrame } from "./render-transcript.ts";
import { buildTranscript, findTranscriptItem, type TranscriptRecord } from "./transcript.ts";

export function renderReadOnlyTranscript(ctx: AgentRenderContext, records: TranscriptRecord[]): string {
  const view = { ...ctx, readOnly: true };
  return buildTranscript(records).map((item) => renderTranscriptItem(view, item)).join("");
}

export function renderReadOnlyTranscriptDetail(ctx: AgentRenderContext, records: TranscriptRecord[], key: string, count: number): string | undefined {
  const item = findTranscriptItem(buildTranscript(records), key);
  return item ? renderTranscriptItemDetailFrame({ ...ctx, readOnly: true }, item, { count }) : undefined;
}
