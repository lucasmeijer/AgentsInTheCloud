import { createHash } from "node:crypto";
import { invalidArguments, runCommand } from "@agents-in-the-cloud/core";
import { getWorkspaceTemplateSshKnownHosts, setWorkspaceTemplateSshKnownHosts } from "./ssh-host-trust.ts";

export interface SshTrustCandidate { host: string; port: number; records: { line: string; fingerprint: string }[] }

export function scanFingerprint(value: string): string {
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) throw invalidArguments("SSH server returned an invalid host key");
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
}

export function sshHostTrustFailure(output: string): { host: string; port: number; changed: boolean } | undefined {
  if (!output.includes("Host key verification failed")) return;
  const changed = output.includes("REMOTE HOST IDENTIFICATION HAS CHANGED");
  const match = changed
    ? output.match(/Host key for (\[[^\]\n]+\]:\d+|[a-zA-Z0-9._:-]+) has changed/)
    : output.match(/No [^\n]* host key is known for (\[[^\]\n]+\]:\d+|[a-zA-Z0-9._:-]+) and you have requested strict checking/);
  if (!match) return;
  const address = match[1]!;
  const bracketed = address.match(/^\[([^\]]+)\]:(\d+)$/);
  const host = bracketed ? bracketed[1]! : address;
  const port = bracketed ? Number(bracketed[2]) : 22;
  if (!/^[a-zA-Z0-9._:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return;
  return { host, port, changed };
}

export function unknownSshHost(output: string): { host: string; port: number } | undefined {
  const failure = sshHostTrustFailure(output);
  return failure && !failure.changed ? { host: failure.host, port: failure.port } : undefined;
}

export async function scanSshHost(host: string, port: number): Promise<SshTrustCandidate> {
  const { stdout } = await runCommand(["ssh-keyscan", "-T", "5", "-p", String(port), host]);
  const records = stdout.toString().split("\n").filter((line) => line && !line.startsWith("#")).map((line) => {
    const fields = line.split(/\s+/);
    if (fields.length !== 3 || !/^(ssh-|ecdsa-|sk-)/.test(fields[1]!)) throw invalidArguments("SSH server returned an invalid host key");
    return { line, fingerprint: scanFingerprint(fields[2]!) };
  });
  if (!records.length) throw invalidArguments("Could not retrieve SSH host keys. Check that the server is reachable and retry.");
  return { host, port, records };
}

export async function trustScannedSshHost(workspaceTemplateId: string, candidate: SshTrustCandidate, selectedLines: string[]): Promise<void> {
  if (!selectedLines.length || selectedLines.some((line) => !candidate.records.some((record) => record.line === line))) throw invalidArguments("The server keys changed. Reopen the trust dialog and verify them again.");
  const existing = await getWorkspaceTemplateSshKnownHosts(workspaceTemplateId);
  const additional = selectedLines.filter((line) => !existing.split("\n").includes(line));
  if (additional.length) await setWorkspaceTemplateSshKnownHosts(workspaceTemplateId, `${existing}${additional.join("\n")}\n`);
}
