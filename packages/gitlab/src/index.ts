import { GitHostingRateLimitError, parseGitHostingResponse, readGitHostingCredentialFile, removeGitHostingCredentialFile, writeGitHostingCredentialFile, type GitHostingProvider, type GitHostingRepository, type GitHostingRepositorySearch, type GitHostingValidation } from "@agents-in-the-cloud/core";
import { Type } from "typebox";
import { gitLabKnownHosts } from "./host-keys.ts";

const tokenFile = "gitlab-token";
const apiBase = "https://gitlab.com/api/v4";

const userResponseSchema = Type.Object({
  id: Type.Integer(),
  username: Type.String({ minLength: 1, pattern: "\\S" }),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  commit_email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const projectsResponseSchema = Type.Array(Type.Object({
  path_with_namespace: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  visibility: Type.Optional(Type.String()),
  http_url_to_repo: Type.String(),
}));

function headers(token: string | undefined): Headers {
  const headers = new Headers({ accept: "application/json", "user-agent": "agents-in-the-cloud" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function optionalTrimmed(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

export async function validateGitLabToken(token: string): Promise<GitHostingValidation> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, message: "Enter a GitLab token." };

  let response: Response;
  try {
    response = await fetch(`${apiBase}/user`, { headers: headers(trimmed) });
  } catch {
    return { ok: false, message: "Could not reach GitLab. Check your network and try again." };
  }

  if (response.status === 401) return { ok: false, message: "GitLab rejected that token. Check that it is active and hasn’t expired." };
  if (response.status === 403) return { ok: false, message: "That token is missing the api scope. Create a new one with the link above." };
  if (!response.ok) return { ok: false, message: `GitLab token validation failed (${response.status}). Try again.` };

  const body = await parseGitHostingResponse(response, userResponseSchema);
  if (!body) return { ok: false, message: "GitLab returned an invalid user response. Try again." };
  const username = body.username.trim();
  const name = optionalTrimmed(body.name) ?? username;
  const email = optionalTrimmed(body.commit_email) ?? optionalTrimmed(body.email) ?? `${body.id}-${username}@users.noreply.gitlab.com`;
  return { ok: true, identity: { name, email } };
}

async function searchProjects(query: string, token: string | undefined, personal: boolean): Promise<GitHostingRepository[]> {
  const url = new URL(`${apiBase}/projects`);
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", "25");
  url.searchParams.set("order_by", personal ? "last_activity_at" : "star_count");
  url.searchParams.set(personal ? "membership" : "visibility", personal ? "true" : "public");

  const response = await fetch(url, { headers: headers(token) });
  if (response.status === 429) throw new GitHostingRateLimitError(`GitLab project search failed: ${response.status}`, response);
  if (!response.ok) throw new Error(`GitLab project search failed: ${response.status} ${await response.text()}`);
  const projects = await parseGitHostingResponse(response, projectsResponseSchema);
  if (!projects) throw new Error("GitLab returned an invalid project search response");
  return projects.map((project) => ({
    fullName: project.path_with_namespace,
    description: project.description,
    private: project.visibility !== "public",
    cloneUrl: project.http_url_to_repo,
    personal,
  }));
}

export async function searchGitLabProjects(query: string, token: string | undefined): Promise<GitHostingRepositorySearch> {
  const trimmed = query.trim();
  const [personal, publicProjects] = await Promise.all([
    token ? searchProjects(trimmed, token, true) : Promise.resolve([]),
    searchProjects(trimmed, token, false),
  ]);
  const seen = new Set(personal.map((project) => project.fullName.toLowerCase()));
  return { repositories: [...personal, ...publicProjects.filter((project) => !seen.has(project.fullName.toLowerCase()))] };
}

export const gitLabProvider: GitHostingProvider = {
  id: "gitlab",
  label: "GitLab",
  gitHost: "gitlab.com",
  gitUsername: "oauth2",
  tokenEnvVar: "GITLAB_TOKEN",
  tokenEnvAliases: [],
  tokenHosts: ["gitlab.com"],
  sshKnownHosts: gitLabKnownHosts,
  connectForm: {
    instructionsHtml: `<p><a class="settings-link" href="https://gitlab.com/-/user_settings/personal_access_tokens?name=AgentsInTheCloud&amp;scopes=api,write_repository" target="_blank" rel="noopener noreferrer">Create a GitLab token</a>. The name and scopes are filled in for you.</p>
    <p>Paste the token below.</p>`,
    tokenPlaceholder: "Paste your GitLab token",
  },
  credential() {
    const token = readGitHostingCredentialFile(tokenFile);
    return token ? { token } : undefined;
  },
  saveCredential(credential) {
    writeGitHostingCredentialFile(tokenFile, `${credential.token.trim()}\n`);
  },
  clearCredential() {
    removeGitHostingCredentialFile(tokenFile);
  },
  workspaceEnv: () => ({}),
  validateCredential: (credential) => validateGitLabToken(credential.token),
  searchRepositories: (query, credential) => searchGitLabProjects(query, credential?.token),
};
