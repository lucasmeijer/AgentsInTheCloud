import { parseSystemVersion, requiredSystemVersionLabel, systemVersion } from "../../../packages/shared/src/system-version.ts";

export function assertAppCompatible(labels: Record<string, string> | null | undefined, version = systemVersion): void {
  const required = parseSystemVersion(labels?.[requiredSystemVersionLabel]);
  if (required > version)
    throw new Error(`To get this version, run the installer again on the computer AgentsInTheCloud is installed on. Existing workspaces will survive but be interrupted. (It needs System version ${required}; this one is ${version}.)`);
}
