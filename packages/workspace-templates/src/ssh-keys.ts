import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentsInTheCloudCoreError, runCommand } from "@agents-in-the-cloud/core";
import { decryptWorkspaceTemplateValue, encryptWorkspaceTemplateValue } from "./secret-crypto.ts";
import { configurationScopeKey, findConfigurationRecord, workspaceTemplateSshKeySummary, workspaceScopes, workspaceTemplatesFile, readWorkspaceTemplateStore, updateWorkspaceTemplateStore, type ConfigurationRecord, type ConfigurationScope, type WorkspaceTemplateSshKeySummary, type StoredWorkspaceTemplateSshKey } from "./workspace-template.ts";

async function publicKeyFromPrivateKey(privateKey: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-ssh-key-"));
  const file = join(directory, "private-key");
  try {
    await writeFile(file, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
    const { stdout, stderr, exitCode } = await runCommand(["ssh-keygen", "-y", "-P", "", "-f", file]);
    if (exitCode !== 0) throw new AgentsInTheCloudCoreError("invalid_ssh_private_key", stderr.trim() || "ssh-keygen rejected the private key; use an unencrypted OpenSSH private key");
    const [keyType, encodedKey] = stdout.toString().trim().split(/\s+/, 2);
    if (!keyType || !encodedKey) throw new AgentsInTheCloudCoreError("invalid_ssh_private_key", "ssh-keygen returned an invalid public key");
    return `${keyType} ${encodedKey}`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function findSshKey(configuration: ConfigurationRecord, keyId: string): StoredWorkspaceTemplateSshKey {
  const key = configuration.sshKeys?.find((candidate) => candidate.id === keyId);
  if (!key) throw new AgentsInTheCloudCoreError("workspace_template_ssh_key_not_found", "template SSH key not found");
  return key;
}

export async function createWorkspaceTemplateSshKey(scope: ConfigurationScope, privateKey: string, file = workspaceTemplatesFile(), keyFile?: string, name = ""): Promise<WorkspaceTemplateSshKeySummary> {
  if (!privateKey.trim()) throw new AgentsInTheCloudCoreError("invalid_arguments", "Private key is required");
  privateKey = privateKey.replace(/\r\n/g, "\n");
  return await updateWorkspaceTemplateStore(file, async (store) => {
    const configuration = findConfigurationRecord(store, scope);
    const id = randomUUID();
    const publicKey = await publicKeyFromPrivateKey(privateKey);
    const key = {
      id,
      projectId: configurationScopeKey(scope),
      name: name.trim(),
      keyType: publicKey.split(" ", 1)[0]!,
      createdAt: new Date().toISOString(),
      encryptedPrivateKey: await encryptWorkspaceTemplateValue(configurationScopeKey(scope), id, privateKey, keyFile),
    };
    configuration.sshKeys ??= [];
    configuration.sshKeys.push(key);
    return workspaceTemplateSshKeySummary(key);
  });
}

export async function deriveWorkspaceTemplateSshPublicKey(scope: ConfigurationScope, keyId: string, file = workspaceTemplatesFile(), keyFile?: string): Promise<string> {
  const configuration = findConfigurationRecord(await readWorkspaceTemplateStore(file), scope);
  const key = findSshKey(configuration, keyId);
  return await publicKeyFromPrivateKey(await decryptWorkspaceTemplateValue(key.projectId, key.id, key.encryptedPrivateKey, keyFile));
}

export async function renameWorkspaceTemplateSshKey(scope: ConfigurationScope, keyId: string, name: string, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateSshKeySummary> {
  return await updateWorkspaceTemplateStore(file, (store) => {
    const configuration = findConfigurationRecord(store, scope);
    const key = findSshKey(configuration, keyId);
    key.name = name.trim();
    return workspaceTemplateSshKeySummary(key);
  });
}

export async function deleteWorkspaceTemplateSshKey(scope: ConfigurationScope, keyId: string, file = workspaceTemplatesFile()): Promise<WorkspaceTemplateSshKeySummary> {
  return await updateWorkspaceTemplateStore(file, (store) => {
    const configuration = findConfigurationRecord(store, scope);
    const key = findSshKey(configuration, keyId);
    configuration.sshKeys = configuration.sshKeys!.filter((candidate) => candidate !== key);
    return workspaceTemplateSshKeySummary(key);
  });
}

export async function revealWorkspaceTemplateSshKeys(scope: ConfigurationScope, file = workspaceTemplatesFile(), keyFile?: string): Promise<string[]> {
  const configuration = findConfigurationRecord(await readWorkspaceTemplateStore(file), scope);
  return await Promise.all((configuration.sshKeys ?? []).map((key) => decryptWorkspaceTemplateValue(key.projectId, key.id, key.encryptedPrivateKey, keyFile)));
}

/** Global keys and the template's own; an SSH agent offers all of them. */
export async function revealEffectiveSshKeys(workspaceTemplateId?: string, file = workspaceTemplatesFile(), keyFile?: string): Promise<string[]> {
  return (await Promise.all(workspaceScopes(workspaceTemplateId).map((scope) => revealWorkspaceTemplateSshKeys(scope, file, keyFile)))).flat();
}
