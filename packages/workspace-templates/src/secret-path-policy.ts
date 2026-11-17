export const secretPathInjectionDefaultHosts: readonly string[] = ["api.telegram.org"];

export function workspaceTemplateSecretHosts(pattern: string): string[] {
  return [...new Set(pattern.split(/[,;]/).map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

export function workspaceTemplateSecretAllowsPath(secret: { hostPattern: string; allowInPath?: boolean }): boolean {
  if (secret.allowInPath !== undefined) return secret.allowInPath;
  const hosts = workspaceTemplateSecretHosts(secret.hostPattern);
  return hosts.length > 0 && hosts.every(host => secretPathInjectionDefaultHosts.includes(host));
}
