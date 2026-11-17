import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceDockerPlan } from "./types.ts";

export async function prepareWorkspaceSystemd(plan: WorkspaceDockerPlan, directory: string, init: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const source = join(directory, "init.sh");
  await writeFile(source, init);
  plan.containerFiles.push({ source, target: "/.agents-in-the-cloud/init.sh" });
  const configuration = join(directory, "agents-in-the-cloud");
  await mkdir(configuration, { recursive: true });
  await writeFile(join(configuration, "docker-support"), `${plan.privileged ? "enabled" : "disabled"}\n${plan.dockerSupportSettingsUrl ?? ""}\n`);
  // docker cp cannot create a file's missing parent directory in a stopped container.
  // Copy the directory into /etc so provisioning owns its creation, too.
  plan.containerFiles.push({ source: configuration, target: "/etc" });
  plan.extraArgs.push(...(plan.privileged ? ["--privileged"] : ["--security-opt", "writable-cgroups=true"]));
  plan.extraArgs.push("--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3");
}
