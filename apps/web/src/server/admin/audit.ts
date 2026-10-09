import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { isNotFoundError } from "@agents-in-the-cloud/core";

export type AdminAuditEntry = { tokenId: string | null; transportPeer: string | null; method: string; operation: string | null; status: number | null; phase: "admitted" | "completed" | "rejected"; requestId: string; suppressed?: number };

/** Serializes rotation and writes; caps storage at two files of about 1 MiB each. */
export function createAdminAudit(path: string, maxBytes = 1024 * 1024) {
  let queue = Promise.resolve();
  return (entry: AdminAuditEntry) => {
    const write = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
      let size = 0;
      try { size = (await stat(path)).size; }
      catch (error) { if (!isNotFoundError(error)) throw error; }
      if (size + Buffer.byteLength(line) > maxBytes) {
        await rm(`${path}.1`, { force: true });
        if (size) await rename(path, `${path}.1`);
      }
      await appendFile(path, line, { mode: 0o600 });
    });
    queue = write.catch(() => {}); // Keep subsequent attempts usable; each caller still receives the failure.
    return write;
  };
}

/** Bounded process-wide budget plus a bounded transport-peer map, not forwarded client headers. */
export function createAdminRateLimit() {
  let windowAt = Date.now();
  let total = 0;
  const peers = new Map<string, number>();
  return (peer: string) => {
    if (Date.now() - windowAt >= 60_000) { windowAt = Date.now(); total = 0; peers.clear(); }
    total++;
    if (total > 600) return false;
    if (!peers.has(peer) && peers.size >= 256) return false;
    const count = (peers.get(peer) ?? 0) + 1;
    peers.set(peer, count);
    return count <= 120;
  };
}
