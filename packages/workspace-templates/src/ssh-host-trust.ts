import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invalidArguments, runCommand, shellQuote, writeFileAtomic } from "@agents-in-the-cloud/core";
import { gitHostingKnownHosts } from "@agents-in-the-cloud/git-hosting";
import { findConfigurationRecord, workspaceScopes, workspaceTemplatesFile, readWorkspaceTemplateStore, updateWorkspaceTemplateStore, type ConfigurationScope } from "./workspace-template.ts";

export async function getWorkspaceTemplateSshKnownHosts(scope: ConfigurationScope, file = workspaceTemplatesFile()): Promise<string> {
  return findConfigurationRecord(await readWorkspaceTemplateStore(file), scope).sshKnownHosts ?? "";
}

export async function setWorkspaceTemplateSshKnownHosts(scope: ConfigurationScope, input: string, file = workspaceTemplatesFile()): Promise<string> {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-host-keys-"));
  try {
    for (const line of lines) {
      if (!/^(?:@(?:cert-authority|revoked)\s+)?\S+\s+(?:ssh-|ecdsa-|sk-)\S+\s+\S+/.test(line)) throw invalidArguments("Use known_hosts records: hostname key-type public-key. Verify keys with the server administrator first.");
      const path = join(directory, "known_hosts");
      await writeFile(path, `${line}\n`);
      const { exitCode } = await runCommand(["ssh-keygen", "-l", "-f", path]);
      if (exitCode !== 0) throw invalidArguments("Invalid SSH host public key. Use verified known_hosts records.");
    }
    const knownHosts = lines.length ? `${lines.join("\n")}\n` : "";
    return await updateWorkspaceTemplateStore(file, (store) => {
      const configuration = findConfigurationRecord(store, scope);
      if (knownHosts) configuration.sshKnownHosts = knownHosts;
      else delete configuration.sshKnownHosts;
      return knownHosts;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareWorkspaceSshTrust(directory: string, workspaceTemplateId?: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "known_hosts");
  const configuredHosts = await Promise.all(workspaceScopes(workspaceTemplateId).map((scope) => getWorkspaceTemplateSshKnownHosts(scope)));
  await writeFileAtomic(path, `${gitHostingKnownHosts}${configuredHosts.join("")}`, { mode: 0o644 });
  return path;
}

export function workspaceGitSshCommand(knownHostsPath: string): string {
  return `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ${shellQuote(`UserKnownHostsFile=${knownHostsPath} ${join(dirname(knownHostsPath), "workspace_known_hosts")} ~/.ssh/known_hosts`)}`;
}
