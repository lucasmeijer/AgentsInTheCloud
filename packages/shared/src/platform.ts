export function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}
