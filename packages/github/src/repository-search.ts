import { createGitHostingCache, GitHostingRateLimitError, type GitHostingRepository, type GitHostingRepositorySearch } from "@agents-in-the-cloud/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { githubHeaders } from "./auth.ts";

const githubRepositorySearchResponseSchema = Type.Object({
  items: Type.Array(Type.Object({
    full_name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    private: Type.Boolean(),
    clone_url: Type.String(),
  })),
});

class GitHubApiError extends Error {}

const ownerCache = createGitHostingCache<string[]>(60_000);

function repositoryOwners(token: string): Promise<string[]> {
  return ownerCache({ token }, "owners", () => loadRepositoryOwners(token));
}

async function loadRepositoryOwners(token: string): Promise<string[]> {
  const userSchema = Type.Object({ login: Type.String() });
  const user = Value.Parse(userSchema, await (await fetchGitHub(new URL("https://api.github.com/user"), token)).json());
  const owners = [user.login];
  for (let page = 1; ; page++) {
    const url = new URL("https://api.github.com/user/orgs");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const orgs = Value.Parse(Type.Array(userSchema), await (await fetchGitHub(url, token)).json());
    owners.push(...orgs.map((org) => org.login));
    if (orgs.length < 100) break;
  }
  return owners;
}

async function searchGitHubRepositoryPage(query: string, token: string | undefined, personal = false): Promise<GitHostingRepository[]> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "25");

  const response = await fetchGitHub(url, token);
  const body = Value.Parse(githubRepositorySearchResponseSchema, await response.json());
  return body.items.map((repo) => ({
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    cloneUrl: repo.clone_url,
    personal,
  }));
}

async function fetchGitHub(url: URL, token: string | undefined): Promise<Response> {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)))) throw new GitHostingRateLimitError(`GitHub repository search failed: ${response.status} ${message}`, response);
    throw new GitHubApiError(`GitHub repository search failed: ${response.status} ${message}`);
  }

  return response;
}

async function searchPersonalRepositories(query: string, token: string | undefined): Promise<GitHostingRepositorySearch> {
  if (!token) return { repositories: [], notice: "Connect GitHub to search your personal and organization repositories." };
  try {
    const owners = await repositoryOwners(token);
    const repositories = await searchGitHubRepositoryPage(`${query} ${owners.map((owner) => `user:${owner}`).join(" ")}`, token, true);
    return { repositories };
  } catch (error) {
    if (error instanceof GitHostingRateLimitError) return { repositories: [], notice: "Your repositories could not be searched: GitHub is rate limited. Try again shortly." };
    if (error instanceof GitHubApiError) return { repositories: [], notice: "Your repositories could not be searched. Check your GitHub connection and organization access." };
    throw error;
  }
}

export async function searchGitHubRepositories(query: string, token: string | undefined): Promise<GitHostingRepositorySearch> {
  const trimmed = query.trim();
  const [publicRepositories, personal] = await Promise.all([
    searchGitHubRepositoryPage(`${trimmed} is:public`, token),
    searchPersonalRepositories(trimmed, token),
  ]);
  const seen = new Set<string>();
  const repositories = [...personal.repositories, ...publicRepositories].filter((repo) => {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { repositories, notice: personal.notice };
}
