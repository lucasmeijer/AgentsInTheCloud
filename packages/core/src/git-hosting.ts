import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { getAgentsInTheCloudRuntimeContext } from "./runtime-context.ts";

export interface GitHostingCredential {
  token: string;
  account?: string;
}

export interface GitHostingIdentity {
  name: string;
  email: string;
}

export type GitHostingValidation = { ok: true; identity: GitHostingIdentity } | { ok: false; message: string };

export interface GitHostingRepository {
  fullName: string;
  description: string | null;
  private: boolean;
  cloneUrl: string;
  personal: boolean;
}

export interface GitHostingRepositorySearch {
  repositories: GitHostingRepository[];
  notice?: string;
}

export interface GitHostingConnectForm {
  instructionsHtml: string;
  tokenPlaceholder: string;
  account?: { label: string; placeholder: string };
}

export interface GitHostingProvider {
  id: string;
  label: string;
  gitHost: string;
  gitUsername: string;
  tokenEnvVar: string;
  tokenEnvAliases: string[];
  tokenHosts: string[];
  sshKnownHosts: string;
  connectForm: GitHostingConnectForm;
  credential(): GitHostingCredential | undefined;
  saveCredential(credential: GitHostingCredential): void;
  clearCredential(): void;
  workspaceEnv(credential: GitHostingCredential): Record<string, string>;
  validateCredential(credential: GitHostingCredential): Promise<GitHostingValidation>;
  searchRepositories(query: string, credential: GitHostingCredential | undefined): Promise<GitHostingRepositorySearch>;
}

export class GitHostingRateLimitError extends Error {
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, response: Response) {
    super(message);
    this.name = "GitHostingRateLimitError";
    this.retryAfterSeconds = Number(response.headers.get("retry-after") ?? undefined) || undefined;
  }
}

export function createGitHostingCache<T>(ttlMs: number): (credential: GitHostingCredential | undefined, key: string, load: () => Promise<T>) => Promise<T> {
  const entries = new Map<string, { expiresAt: number; value: T }>();
  return async (credential, key, load) => {
    const now = Date.now();
    for (const [entryKey, entry] of entries) if (entry.expiresAt <= now) entries.delete(entryKey);
    const credentialKey = credential ? createHash("sha256").update(`${credential.account ?? ""}:${credential.token}`).digest("hex") : "anonymous";
    const cacheKey = `${credentialKey}:${key}`;
    const cached = entries.get(cacheKey);
    if (cached) return cached.value;
    const value = await load();
    entries.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
    return value;
  };
}

export function gitHostingCredentialPath(fileName: string): string {
  return join(getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "workspace", fileName);
}

export function readGitHostingCredentialFile(fileName: string): string | undefined {
  const path = gitHostingCredentialPath(fileName);
  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}

export function writeGitHostingCredentialFile(fileName: string, contents: string): void {
  const path = gitHostingCredentialPath(fileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}

export function removeGitHostingCredentialFile(fileName: string): void {
  rmSync(gitHostingCredentialPath(fileName), { force: true });
}

export async function parseGitHostingResponse<Schema extends TSchema>(response: Response, schema: Schema): Promise<Static<Schema> | undefined> {
  try {
    return Value.Parse(schema, await response.json());
  } catch {
    return undefined;
  }
}

type CredentialHelperProvider = Pick<GitHostingProvider, "gitHost" | "gitUsername" | "tokenEnvVar">;

export function gitCredentialHelperShellBody(providers: readonly CredentialHelperProvider[]): string {
  const cases = providers.map((provider) => `    ${provider.gitHost}|${provider.gitHost}:443) username=${provider.gitUsername}; token="\${${provider.tokenEnvVar}:-}" ;;`).join("\n");
  return `test "$1" = get || exit 0
protocol=
host=
while IFS='=' read -r key value; do
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
  esac
done
[ "$protocol" = https ] || exit 0
case "$host" in
${cases}
    *) exit 0 ;;
esac
[ -n "$token" ] || exit 0
echo username="$username"
echo password="$token"`;
}
