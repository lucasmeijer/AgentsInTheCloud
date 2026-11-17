import type { JsonObject } from "@agents-in-the-cloud/core";
import { readJsonSettings } from "@agents-in-the-cloud/core/json-settings";

/** The CLI session auth provider and credential-helper children fetch URLs chosen
 * by registries. A private daemon alone does not isolate those host-side fetches.
 * No local-Docker or older-System fallback for repository-controlled builds. */
export async function repositoryBuildCommand(args: string[]): Promise<string[]> {
  const resources = await readJsonSettings("/run/agents-in-the-cloud-system/resources.json");
  return protectedRepositoryBuildCommand(resources, args);
}

export function protectedRepositoryBuildCommand(resources: JsonObject, args: string[]): string[] {
  if (resources.buildClientNetworkPolicy !== 1)
    throw new Error("Repository Dockerfile builds require System build-client network protection. Update System or use a prebuilt workspace image.");

  return ["sh", "-ec", 'echo $$ > /run/agents-in-the-cloud-system/build-client-processes/cgroup.procs; exec "$@"', "agents-in-the-cloud-build", ...args];
}
