export function filesystemFailure(filesystems: string): string | undefined {
  const available = new Set(filesystems.trim().split(/\s+/));
  const missing = ["erofs", "overlay"].filter((name) => !available.has(name));
  if (!missing.length) return;
  return `The Linux kernel that powers your Docker does not have ${missing.join(", ")}, which AgentsInTheCloud requires.`;
}
