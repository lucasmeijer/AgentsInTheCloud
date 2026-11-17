import { gitCredentialHelperShellBody as credentialHelperShellBody, invalidArguments, type GitHostingCredential, type GitHostingProvider } from "@agents-in-the-cloud/core";
import { bitbucketProvider } from "@agents-in-the-cloud/bitbucket";
import { gitHubProvider } from "@agents-in-the-cloud/github";
import { gitLabProvider } from "@agents-in-the-cloud/gitlab";

export const gitHostingProviders: readonly GitHostingProvider[] = [gitHubProvider, gitLabProvider, bitbucketProvider];

export function gitHostingProvider(id: string): GitHostingProvider {
  const provider = gitHostingProviders.find((candidate) => candidate.id === id);
  if (!provider) throw invalidArguments(`unknown git hosting provider: ${id}`);
  return provider;
}

export function connectedGitHostingProviders(): Array<{ provider: GitHostingProvider; credential: GitHostingCredential }> {
  return gitHostingProviders.flatMap((provider) => {
    const credential = provider.credential();
    return credential ? [{ provider, credential }] : [];
  });
}

const listeners = new Set<() => void>();

export function onGitHostingCredentialsChanged(listener: () => void): void {
  listeners.add(listener);
}

export function saveGitHostingCredential(provider: GitHostingProvider, credential: GitHostingCredential): void {
  provider.saveCredential(credential);
  for (const listener of listeners) listener();
}

export function clearGitHostingCredential(provider: GitHostingProvider): void {
  provider.clearCredential();
  for (const listener of listeners) listener();
}

export const gitCredentialHelperShellBody = credentialHelperShellBody(gitHostingProviders);

export const gitCredentialHelperCommand = `!f() { ${gitCredentialHelperShellBody}; }; f`;

export function gitHostingTokenEnvironment(): Record<string, string> {
  return Object.fromEntries(connectedGitHostingProviders().map(({ provider, credential }) => [provider.tokenEnvVar, credential.token]));
}

export const gitHostingKnownHosts = gitHostingProviders.map((provider) => provider.sshKnownHosts).join("");

export function gitHostingShorthandUrl(spec: string): string | undefined {
  return gitHostingProviders.some((provider) => spec.toLowerCase().startsWith(`${provider.gitHost}/`)) ? `https://${spec}` : undefined;
}
