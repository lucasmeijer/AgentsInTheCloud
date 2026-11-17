import { readFile } from "node:fs/promises";
import { agentsInTheCloudDataPath, createKeyedOperationQueue, getAgentsInTheCloudRuntimeContext, invalidArguments, readTextIfExists, writeFileAtomic } from "@agents-in-the-cloud/core";
import { scanFingerprint, type SshTrustCandidate } from "./ssh-trust-recovery.ts";

export interface WorkspaceSshTrustRequest extends SshTrustCandidate {
  id: string;
  workspaceId: string;
  changed: boolean;
}

type Pending = { request: WorkspaceSshTrustRequest; resolve: (lines: string) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const listeners = new Set<(workspaceId: string) => void>();
const withTrustLock = createKeyedOperationQueue();

export function onWorkspaceSshTrustChanged(listener: (workspaceId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changed(workspaceId: string): void { for (const listener of listeners) listener(workspaceId); }

export function workspaceSshTrustRequests(workspaceId: string): WorkspaceSshTrustRequest[] {
  return [...pending.values()].filter(item => item.request.workspaceId === workspaceId).map(item => item.request);
}

function workspaceTrustPath(workspaceId: string): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "ssh-agents", workspaceId, "workspace_known_hosts");
}

export async function workspaceKnownHosts(workspaceId: string): Promise<string> {
  return await readTextIfExists(workspaceTrustPath(workspaceId)) ?? "";
}

export async function requestWorkspaceSshTrust(workspaceId: string, host: string, port: number, input: string): Promise<string> {
  if (!/^[a-zA-Z0-9._:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw invalidArguments("Invalid SSH server address");
  const address = port === 22 ? host : `[${host}]:${port}`;
  const records = input.split("\n").filter(line => line && !line.startsWith("#")).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3 || parts[0] !== address || !/^(ssh-|ecdsa-|sk-)/.test(parts[1]!)) throw invalidArguments("Invalid scanned SSH key");
    return { line: parts.join(" "), fingerprint: scanFingerprint(parts[2]!) };
  });
  if (!records.length || records.length > 20 || input.length > 20_000) throw invalidArguments("No SSH host keys were returned");
  const trusted = `${await readFile(agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "ssh-agents", workspaceId, "known_hosts"), "utf8")}${await workspaceKnownHosts(workspaceId)}`;
  const hostRecords = trusted.split("\n").filter(line => line.split(/\s+/)[0]?.split(",").includes(address));
  if (records.some(record => hostRecords.includes(record.line))) return trusted;
  const existing = [...pending.values()].find(item => item.request.workspaceId === workspaceId && item.request.host === host && item.request.port === port);
  if (existing) {
    if (existing.request.records.map(record => record.line).join("\n") !== records.map(record => record.line).join("\n")) {
      pending.delete(existing.request.id);
      clearTimeout(existing.timer);
      existing.resolve("");
      changed(workspaceId);
    } else return await new Promise(resolve => {
      const original = existing.resolve;
      existing.resolve = lines => { original(lines); resolve(lines); };
    });
  }
  const request: WorkspaceSshTrustRequest = { id: crypto.randomUUID(), workspaceId, host, port, records, changed: hostRecords.length > 0 };
  return await new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      resolve("");
      changed(workspaceId);
    }, 30 * 60_000);
    pending.set(request.id, { request, resolve, timer });
    changed(workspaceId);
  });
}

export async function decideWorkspaceSshTrust(workspaceId: string, requestId: string, accepted: string[]): Promise<void> {
  await withTrustLock(workspaceId, async () => {
    const item = pending.get(requestId);
    if (!item || item.request.workspaceId !== workspaceId) throw invalidArguments("SSH trust request is no longer pending");
    if (accepted.length && accepted.some(line => !item.request.records.some(record => record.line === line))) throw invalidArguments("The SSH keys changed; review the request again");
    if (accepted.length) {
      const path = workspaceTrustPath(workspaceId);
      const previous = await workspaceKnownHosts(workspaceId);
      const additions = accepted.filter(line => !previous.split("\n").includes(line));
      const address = item.request.port === 22 ? item.request.host : `[${item.request.host}]:${item.request.port}`;
      const retained = item.request.changed ? previous.split("\n").filter(line => line && !line.split(/\s+/)[0]?.split(",").includes(address)).join("\n") : previous.trimEnd();
      const content = `${retained ? `${retained}\n` : ""}${(item.request.changed ? accepted : additions).join("\n")}\n`;
      await writeFileAtomic(path, content);
      item.resolve(content);
    } else item.resolve("");
    pending.delete(requestId);
    clearTimeout(item.timer);
    changed(workspaceId);
  });
}

export function cancelWorkspaceSshTrust(workspaceId: string): void {
  for (const item of workspaceSshTrustRequests(workspaceId)) {
    const pendingItem = pending.get(item.id)!;
    pending.delete(item.id);
    clearTimeout(pendingItem.timer);
    pendingItem.resolve("");
  }
  changed(workspaceId);
}
