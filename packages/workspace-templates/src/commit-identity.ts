import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentsInTheCloudRuntimeContext, invalidArguments, isNotFoundError, shellQuote, writeJsonAtomic, type AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const commitIdentitySchema = Type.Object({
  name: Type.String(),
  email: Type.String(),
});

export type CommitIdentitySettings = Static<typeof commitIdentitySchema>;

const storedCommitIdentitySchema = Type.Object({
  gitIdentity: Type.Optional(commitIdentitySchema),
});

type CommitIdentityStore = Static<typeof storedCommitIdentitySchema>;

export function commitIdentitySettingsFile(dataDir = getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir): string {
  return join(dataDir, "project-settings.json");
}

async function readStore(file: string): Promise<CommitIdentityStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Value.Check(storedCommitIdentitySchema, parsed) || !parsed.gitIdentity) return {};
    const name = parsed.gitIdentity.name.trim();
    const email = parsed.gitIdentity.email.trim();
    return name && email ? { gitIdentity: { name, email } } : {};
  } catch (error) {
    if (isNotFoundError(error)) return {};
    throw error;
  }
}

async function writeStore(file: string, store: CommitIdentityStore): Promise<void> {
  await writeJsonAtomic(file, store);
}

function validateCommitIdentity(identity: CommitIdentitySettings): CommitIdentitySettings {
  const name = identity.name.trim();
  const email = identity.email.trim();
  if (!name) throw invalidArguments("commit author name is required");
  if (!email) throw invalidArguments("commit author email is required");
  if (/\r|\n/.test(name) || /\r|\n/.test(email)) throw invalidArguments("commit identity must fit on one line");
  return { name, email };
}

function execGitConfig(key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["config", "--global", "--get", key], { encoding: "utf8" }, (error, stdout) => {
      if (error) return resolve(undefined);
      const value = stdout.trim();
      resolve(value || undefined);
    });
  });
}

async function getHostGlobalCommitIdentity(): Promise<CommitIdentitySettings | undefined> {
  const [name, email] = await Promise.all([execGitConfig("user.name"), execGitConfig("user.email")]);
  if (!name || !email) return undefined;
  try {
    return validateCommitIdentity({ name, email });
  } catch {
    return undefined;
  }
}

function shouldAdoptHostGlobalCommitIdentity(file: string): boolean {
  return file === commitIdentitySettingsFile();
}

export async function getStoredCommitIdentity(file = commitIdentitySettingsFile()): Promise<CommitIdentitySettings | undefined> {
  return (await readStore(file)).gitIdentity;
}

export async function getCommitIdentity(file = commitIdentitySettingsFile()): Promise<CommitIdentitySettings | undefined> {
  const stored = await getStoredCommitIdentity(file);
  if (stored || !shouldAdoptHostGlobalCommitIdentity(file)) return stored;
  const hostIdentity = await getHostGlobalCommitIdentity();
  if (!hostIdentity) return undefined;
  await writeStore(file, { gitIdentity: hostIdentity });
  return hostIdentity;
}

export async function hasCommitIdentity(file = commitIdentitySettingsFile()): Promise<boolean> {
  return Boolean(await getCommitIdentity(file));
}

export async function setCommitIdentity(identity: CommitIdentitySettings, file = commitIdentitySettingsFile()): Promise<CommitIdentitySettings> {
  const validated = validateCommitIdentity(identity);
  await writeStore(file, { gitIdentity: validated });
  return validated;
}

export async function clearCommitIdentity(file = commitIdentitySettingsFile()): Promise<void> {
  await writeStore(file, {});
}

export function registerCommitIdentityWorkspaceEvents(events: AgentsInTheCloudEventBus): void {
  events.on("workspace_plan_prepare", async ({ plan }) => {
    const identity = await getCommitIdentity();
    if (!identity) return;
    const script = `git config --system user.name ${shellQuote(identity.name)}; git config --system user.email ${shellQuote(identity.email)}`;
    plan.initScripts.push(script);
  });
}
