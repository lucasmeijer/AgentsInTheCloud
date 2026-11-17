import { basename, join } from "node:path";
import { publishSessionSnapshot, sessionShareDir, workspaceSessionShareKey } from "@agents-in-the-cloud/agent/server/session-share";

export async function exportCliHistory(workspaceId: string, provider: string, tabId: string, slug: string, sources: string[]): Promise<void> {
  if (!sources.length) return;
  const destination = sessionShareDir(await workspaceSessionShareKey(workspaceId));
  for (const source of sources) {
    const nativeId = basename(source, ".jsonl").replace(/[^a-zA-Z0-9-]/g, "-");
    await publishSessionSnapshot(source, join(destination, `${provider}--${slug}--${workspaceId}--${tabId}--${nativeId}.jsonl`));
  }
}
