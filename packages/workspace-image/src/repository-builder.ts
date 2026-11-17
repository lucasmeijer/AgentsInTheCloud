import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentsInTheCloudDataPath, dockerHostAgentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, requireDocker, runCommand, shellQuote, workloadCgroupArgs } from "@agents-in-the-cloud/core";
import { repositoryBuildCommand } from "./build-network.ts";
import { dockerImageId } from "./local-images.ts";
import { workspaceImagePruneArgs } from "./prune.ts";

const runtimeImageFile = new URL("../runtime-image", import.meta.url);
const roleLabel = "com.agents-in-the-cloud.role=repository-builder";

/** A persistent private daemon, not the System daemon, owns untrusted builds.
 * Its HTTP sources, image pulls and RUN steps all originate behind the workload
 * firewall. The CLI session auth provider is separately confined by the System
 * build-client output policy. Only management receives its Unix socket; no TCP API or host socket
 * is exposed. Call under the image-store queue (including base alias updates).
 * The cache volume survives workspace deletion and builder/runtime replacement.
 */
export async function buildRepositoryImage(baseImage: string, tag: string, build: (dockerCommand: string[]) => Promise<void>): Promise<void> {
  const buildCommand = await repositoryBuildCommand(["docker"]);
  const runtime = getAgentsInTheCloudRuntimeContext();
  const identity = createHash("sha256").update(`${runtime.dockerHostAgentsInTheCloudDataDir}\0${process.env.ATELIER_NAMESPACE ?? "host"}`).digest("hex").slice(0, 16);
  const name = `agents-in-the-cloud-builder-${identity}`;
  const directory = agentsInTheCloudDataPath(runtime, "repository-builder", identity);
  const hostDirectory = dockerHostAgentsInTheCloudDataPath(runtime, "repository-builder", identity);
  const image = (await readFile(runtimeImageFile, "utf8")).trim();
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let exists = (await requireDocker(["ps", "-aq", "--filter", `name=^${name}$`])).stdout.trim() !== "";
  if (exists) {
    const inspected = JSON.parse((await requireDocker(["inspect", name])).stdout)[0];
    if (inspected.Config.Image !== image) {
      await requireDocker(["stop", "--time", "120", name]);
      await requireDocker(["rm", name]);
      exists = false;
    } else if (!inspected.State.Running) {
      await requireDocker(["start", name]);
    }
  }
  if (!exists) {
    // Reuse this exact runtime's configuration instead of maintaining a second
    // copy of its storage/containerd settings in the app. Change only the socket.
    const config = JSON.parse((await requireDocker(["run", "--rm", "--network=none", "--entrypoint", "cat", image, "/etc/docker/daemon.json"])).stdout);
    config.hosts = ["unix:///control/docker.sock"];
    await writeFile(join(directory, "daemon.json"), JSON.stringify(config));
    if (!(await requireDocker(["network", "ls", "-q", "--filter", `name=^${name}$`])).stdout.trim()) {
      await requireDocker(["network", "create", "--driver", "bridge", "--label", roleLabel, name]);
    }
    await requireDocker([
      "run", "-d", "--name", name, "--label", roleLabel,
      "--restart", "unless-stopped", "--stop-timeout", "120",
      // The trusted daemon needs mounts/devices for the shipped EROFS runtime.
      // Build containers themselves are NOT privileged or granted entitlements.
      "--privileged", "--cgroupns=private", ...await workloadCgroupArgs(),
      "--network", name, "--tmpfs", "/run",
      "--mount", `type=volume,src=${name},dst=/data`,
      "--mount", `type=bind,src=${hostDirectory},dst=/control`,
      "--mount", `type=bind,src=${hostDirectory}/daemon.json,dst=/etc/docker/daemon.json,readonly`,
      image, "dockerd",
    ]);
  }

  // Readiness is bounded and explicit. Never fall back to the System builder.
  // The repository builder is a Docker daemon container, not a workspace.
  // oxlint-disable-next-line agents-in-the-cloud/no-docker-exec
  await requireDocker(["exec", name, "sh", "-ec",
    'for attempt in $(seq 1 120); do if docker --host unix:///control/docker.sock info >/dev/null 2>&1; then chmod 0666 /control/docker.sock; exit 0; fi; sleep 0.5; done; echo "Repository builder failed to start" >&2; exit 1',
  ]);
  const builder = ["--host", `unix://${join(directory, "docker.sock")}`];
  const docker = (args: string[]) => requireDocker([...builder, ...args]);
  const baseId = await dockerImageId(baseImage);
  const images = await docker(["image", "ls", "--no-trunc", "-q"]);
  if (!images.stdout.split(/\s+/).includes(baseId)) {
    await pipe(["docker", "save", baseId], ["docker", ...builder, "load"]);
  }
  await docker(["tag", baseId, "agents-in-the-cloud-workspace"]);
  const buildStartedAt = new Date();
  await build([...buildCommand, ...builder]);
  // Publishing back preserves the ordinary workspace creation/run path. Stream
  // archives rather than buffering multi-GB images in the management process.
  await pipe(["docker", ...builder, "save", tag], ["docker", "load"]);
  await docker(workspaceImagePruneArgs("repository", buildStartedAt));
}

async function pipe(source: string[], destination: string[]): Promise<void> {
  const result = await runCommand(["bash", "-o", "pipefail", "-c", `${source.map(shellQuote).join(" ")} | ${destination.map(shellQuote).join(" ")}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Repository builder image transfer failed");
}
