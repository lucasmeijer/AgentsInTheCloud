// Portions adapted from @earendil-works/gondolin, Apache-2.0.
// Source: https://github.com/earendil-works/gondolin

export function normalizeHostnamePattern(pattern: string): string {
  return pattern.trim().toLowerCase().replace(/\.$/, "");
}

export function matchHostname(hostname: string, pattern: string): boolean {
  const normalizedHostname = normalizeHostnamePattern(hostname);
  const normalizedPattern = normalizeHostnamePattern(pattern);
  if (!normalizedHostname || !normalizedPattern) return false;
  if (normalizedPattern === "*") return true;

  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(normalizedHostname);
}

export function matchesAnyHost(hostname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchHostname(hostname, pattern));
}
