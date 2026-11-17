import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { autocompleteHtml } from "@agents-in-the-cloud/design-system/autocomplete";
import { createGitHostingCache, GitHostingRateLimitError, type GitHostingCredential, type GitHostingProvider, type GitHostingRepositorySearch } from "@agents-in-the-cloud/core";
import { gitHostingProviders } from "@agents-in-the-cloud/git-hosting";
import { errorMessage, escapeHtml, providerBrandIconHtml } from "@agents-in-the-cloud/shared";

interface ProviderRepositorySearch extends GitHostingRepositorySearch {
  provider: GitHostingProvider;
}

const searchCache = createGitHostingCache<GitHostingRepositorySearch>(60_000);

async function searchProvider(provider: GitHostingProvider, credential: GitHostingCredential | undefined, query: string): Promise<GitHostingRepositorySearch> {
  try {
    return await searchCache(credential, `${provider.id}:${query.toLowerCase()}`, () => provider.searchRepositories(query, credential));
  } catch (error) {
    if (error instanceof GitHostingRateLimitError) {
      const wait = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds} seconds.` : " Try again in a few minutes.";
      return { repositories: [], notice: `${provider.label} search is rate limited.${wait}` };
    }
    console.error(`[repository-search] ${provider.label} search failed`, error);
    return { repositories: [], notice: `${provider.label} search failed: ${errorMessage(error)}` };
  }
}

export async function searchRepositories(query: string): Promise<ProviderRepositorySearch[]> {
  const trimmed = query.trim();
  const searches = gitHostingProviders.flatMap((provider) => {
    const credential = provider.credential();
    return credential || provider.id === "github" ? [{ provider, credential }] : [];
  });
  return await Promise.all(searches.map(async ({ provider, credential }) => ({ provider, ...await searchProvider(provider, credential, trimmed) })));
}

function repositoryRowsHtml(provider: GitHostingProvider, label: string, search: ProviderRepositorySearch, personal: boolean): string {
  const repositories = search.repositories.filter((repo) => repo.personal === personal);
  if (repositories.length === 0) return "";
  const heading = `<div class="workspace-template-repository-heading">${providerBrandIconHtml(provider.id, provider.label, "brand-icon workspace-template-repository-heading-icon")}${escapeHtml(label)}</div>`;
  return heading + autocompleteHtml({ kind: "results", label, contentHtml: repositories.map((repo) => {
    const title = [repo.fullName, repo.description, repo.private ? "Private repository" : undefined].filter(Boolean).join(" — ");
    return contentRowHtml({
      width: "fill",
      kind: "compact",
      label: { kind: "text", text: repo.fullName },
      trailingHtml: repo.private ? "<span>Private</span>" : undefined,
      element: {
        tag: "button",
        attributesHtml: `type="button" role="option" aria-selected="false" data-git-url="${escapeHtml(repo.cloneUrl)}" title="${escapeHtml(title)}"`,
      },
    });
  }).join("") });
}

export function renderRepositorySearchMenu(searches: ProviderRepositorySearch[]): string {
  const notices = searches.flatMap((search) => search.notice ? [autocompleteHtml({ kind: "message", role: "status", content: { kind: "text", text: search.notice } })] : []).join("");
  if (searches.every((search) => search.repositories.length === 0)) return notices + autocompleteHtml({ kind: "message", content: { kind: "text", text: "No repositories found" } });
  const yours = searches.map((search) => repositoryRowsHtml(search.provider, `Your ${search.provider.label} repositories`, search, true)).join("");
  const publicRepositories = searches.map((search) => repositoryRowsHtml(search.provider, `Public ${search.provider.label} repositories`, search, false)).join("");
  return notices + yours + publicRepositories;
}
