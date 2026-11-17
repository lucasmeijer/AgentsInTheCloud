export function isSshAuthenticationFailure(diagnostic: string): boolean {
  return /permission denied \([^\r\n)]*\bpublickey\b[^\r\n)]*\)/i.test(diagnostic);
}
