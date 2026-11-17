import { createGitHostingCache, GitHostingRateLimitError, parseGitHostingResponse, readGitHostingCredentialFile, removeGitHostingCredentialFile, writeGitHostingCredentialFile, type GitHostingCredential, type GitHostingProvider, type GitHostingRepository, type GitHostingRepositorySearch, type GitHostingValidation } from "@agents-in-the-cloud/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { bitbucketKnownHosts } from "./host-keys.ts";

const credentialFile = "bitbucket-credential.json";
const apiBase = "https://api.bitbucket.org/2.0";

const storedCredentialSchema = Type.Object({ email: Type.String(), token: Type.String() });

const userResponseSchema = Type.Object({
  display_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  nickname: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const workspacesResponseSchema = Type.Object({
  values: Type.Array(Type.Object({ workspace: Type.Object({ slug: Type.String() }) })),
  next: Type.Optional(Type.String()),
});

const repositoriesResponseSchema = Type.Object({
  values: Type.Array(Type.Object({
    full_name: Type.String(),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    is_private: Type.Boolean(),
  })),
});

function headers(credential: GitHostingCredential): HeadersInit {
  return { accept: "application/json", "user-agent": "agents-in-the-cloud", authorization: `Basic ${btoa(`${credential.account ?? ""}:${credential.token}`)}` };
}

export async function validateBitbucketCredential(credential: GitHostingCredential): Promise<GitHostingValidation> {
  const token = credential.token.trim();
  const email = credential.account?.trim() ?? "";
  if (!email) return { ok: false, message: "Enter the email address of your Atlassian account." };
  if (!token) return { ok: false, message: "Enter a Bitbucket API token." };

  let response: Response;
  try {
    response = await fetch(`${apiBase}/user`, { headers: headers({ token, account: email }) });
  } catch {
    return { ok: false, message: "Could not reach Bitbucket. Check your network and try again." };
  }

  if (response.status === 401) return { ok: false, message: "Bitbucket rejected that email and token. Check both, and that the token hasn’t expired." };
  if (response.status === 403) return { ok: false, message: "That token is missing some scopes. Create a new one with the scopes listed above." };
  if (!response.ok) return { ok: false, message: `Bitbucket token validation failed (${response.status}). Try again.` };

  const body = await parseGitHostingResponse(response, userResponseSchema);
  if (!body) return { ok: false, message: "Bitbucket returned an invalid user response. Try again." };
  const name = body.display_name?.trim() || body.nickname?.trim() || email;
  return { ok: true, identity: { name, email } };
}

class BitbucketAccessError extends Error {}

async function fetchBitbucket(url: URL | string, credential: GitHostingCredential): Promise<Response> {
  const response = await fetch(url, { headers: headers(credential) });
  if (response.status === 429) throw new GitHostingRateLimitError(`Bitbucket request failed: ${response.status}`, response);
  if (response.status === 401 || response.status === 403) throw new BitbucketAccessError(`Bitbucket request failed: ${response.status}`);
  if (!response.ok) throw new Error(`Bitbucket request failed: ${response.status} ${await response.text()}`);
  return response;
}

const workspaceCache = createGitHostingCache<string[]>(60_000);

async function loadWorkspaceSlugs(credential: GitHostingCredential): Promise<string[]> {
  const slugs: string[] = [];
  let next: string | undefined = `${apiBase}/user/workspaces?pagelen=100`;
  while (next) {
    const page: Static<typeof workspacesResponseSchema> | undefined = await parseGitHostingResponse(await fetchBitbucket(next, credential), workspacesResponseSchema);
    if (!page) throw new Error("Bitbucket returned an invalid workspace list");
    slugs.push(...page.values.map((value) => value.workspace.slug));
    next = page.next;
  }
  return slugs;
}

async function searchWorkspace(slug: string, query: string, credential: GitHostingCredential): Promise<GitHostingRepository[]> {
  const url = new URL(`${apiBase}/repositories/${encodeURIComponent(slug)}`);
  url.searchParams.set("q", `name ~ "${query.replace(/["\\]/g, "\\$&")}"`);
  url.searchParams.set("sort", "-updated_on");
  url.searchParams.set("pagelen", "25");
  const body = await parseGitHostingResponse(await fetchBitbucket(url, credential), repositoriesResponseSchema);
  if (!body) throw new Error("Bitbucket returned an invalid repository search response");
  return body.values.map((repo) => ({
    fullName: repo.full_name,
    description: repo.description || null,
    private: repo.is_private,
    cloneUrl: `https://bitbucket.org/${repo.full_name}.git`,
    personal: true,
  }));
}

export async function searchBitbucketRepositories(query: string, credential: GitHostingCredential | undefined): Promise<GitHostingRepositorySearch> {
  if (!credential) return { repositories: [], notice: "Connect Bitbucket to search your repositories." };
  try {
    const slugs = await workspaceCache(credential, "workspaces", () => loadWorkspaceSlugs(credential));
    const results = await Promise.all(slugs.map((slug) => searchWorkspace(slug, query.trim(), credential)));
    return { repositories: results.flat() };
  } catch (error) {
    if (error instanceof BitbucketAccessError) return { repositories: [], notice: "Your Bitbucket repositories could not be searched. Check your Bitbucket connection." };
    throw error;
  }
}

export const bitbucketProvider: GitHostingProvider = {
  id: "bitbucket",
  label: "Bitbucket",
  gitHost: "bitbucket.org",
  gitUsername: "x-bitbucket-api-token-auth",
  tokenEnvVar: "BITBUCKET_API_TOKEN",
  tokenEnvAliases: ["BKT_TOKEN"],
  tokenHosts: ["bitbucket.org", "api.bitbucket.org"],
  sshKnownHosts: bitbucketKnownHosts,
  connectForm: {
    instructionsHtml: `<p><a class="settings-link" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">Create an API token with scopes</a>, choose Bitbucket, and tick these scopes:</p>
    <pre class="settings-command">read:user:bitbucket
read:workspace:bitbucket
read:repository:bitbucket
write:repository:bitbucket
read:pullrequest:bitbucket
write:pullrequest:bitbucket</pre>
    <p>Enter your Atlassian account email and paste the token below.</p>`,
    tokenPlaceholder: "Paste your Bitbucket API token",
    account: { label: "Atlassian account email", placeholder: "you@example.com" },
  },
  credential() {
    const stored = readGitHostingCredentialFile(credentialFile);
    if (!stored) return undefined;
    const { email, token } = Value.Parse(storedCredentialSchema, JSON.parse(stored));
    return { token, account: email };
  },
  saveCredential(credential) {
    writeGitHostingCredentialFile(credentialFile, `${JSON.stringify({ email: credential.account?.trim() ?? "", token: credential.token.trim() })}\n`);
  },
  clearCredential() {
    removeGitHostingCredentialFile(credentialFile);
  },
  workspaceEnv: (credential) => ({ BITBUCKET_EMAIL: credential.account ?? "", BKT_USERNAME: credential.account ?? "", BKT_HOST: "https://bitbucket.org" }),
  validateCredential: validateBitbucketCredential,
  searchRepositories: searchBitbucketRepositories,
};
