import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

export interface AgentsInTheCloudRuntimeContext {
  agentsInTheCloudDataDir: string;
  dockerHostAgentsInTheCloudDataDir: string;
  dockerBridgeHost: string;
}

let cachedRuntimeContext: AgentsInTheCloudRuntimeContext | undefined;
let cachedRuntimeContextKey: string | undefined;

export function agentsInTheCloudDataPath(context: AgentsInTheCloudRuntimeContext, ...segments: string[]): string {
  return join(context.agentsInTheCloudDataDir, ...segments);
}

export function dockerHostAgentsInTheCloudDataPath(context: AgentsInTheCloudRuntimeContext, ...segments: string[]): string {
  return join(context.dockerHostAgentsInTheCloudDataDir, ...segments);
}

export function getAgentsInTheCloudRuntimeContext(): AgentsInTheCloudRuntimeContext {
  const paths = runtimePathsFromEnv();
  const key = `${paths.agentsInTheCloudDataDir}\0${paths.dockerHostAgentsInTheCloudDataDir}`;
  if (!cachedRuntimeContext || cachedRuntimeContextKey !== key) {
    cachedRuntimeContext = createRuntimeContext(paths);
    cachedRuntimeContextKey = key;
  }
  return cachedRuntimeContext;
}

export function resetAgentsInTheCloudRuntimeContextForTests(): void {
  cachedRuntimeContext = undefined;
  cachedRuntimeContextKey = undefined;
}

function createRuntimeContext(paths: Pick<AgentsInTheCloudRuntimeContext, "agentsInTheCloudDataDir" | "dockerHostAgentsInTheCloudDataDir">): AgentsInTheCloudRuntimeContext {
  let dockerBridgeHost: string | undefined;
  return {
    ...paths,
    get dockerBridgeHost() {
      return dockerBridgeHost ??= inspectDockerBridgeHost();
    },
  };
}

function runtimePathsFromEnv(): Pick<AgentsInTheCloudRuntimeContext, "agentsInTheCloudDataDir" | "dockerHostAgentsInTheCloudDataDir"> {
  const agentsInTheCloudDataDir = envString("ATELIER_DATA_DIR") ?? defaultDataDir();
  return {
    agentsInTheCloudDataDir,
    dockerHostAgentsInTheCloudDataDir: envString("ATELIER_DOCKER_HOST_DATA_DIR") ?? agentsInTheCloudDataDir,
  };
}

function xdgDataHome(): string {
  const configured = process.env.XDG_DATA_HOME;
  if (configured && isAbsolute(configured)) return configured;
  return join(homedir(), ".local", "share");
}

function defaultDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "agents-in-the-cloud-host");
  if (platform() === "linux") return join(xdgDataHome(), "agents-in-the-cloud-host");
  return "/var/lib/agents-in-the-cloud-host";
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function inspectDockerBridgeHost(): string {
  // Docker Desktop's bridge gateway lives inside its Linux VM and cannot route
  // back to a server listening on the macOS host.
  if (platform() === "darwin") return "host.docker.internal";
  const result = Bun.spawnSync(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`could not inspect Docker bridge gateway: ${new TextDecoder().decode(result.stderr).trim()}`);
  const host = new TextDecoder().decode(result.stdout).trim();
  if (!host) throw new Error("Docker bridge gateway is empty");
  return host;
}
