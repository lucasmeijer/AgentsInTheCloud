import { createHash } from "node:crypto";
import { workspaceHomeMounts } from "./home.ts";
import { workspaceImagePreloader } from "./preload.ts";
import type { WorkspaceImageConfigureEvent } from "./events.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitCredentialHelperShellBody } from "@agents-in-the-cloud/git-hosting";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, createProcessFileLock, dockerHostAgentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, invalidArguments, isJsonObject, readTextIfExists, requireDocker, runDocker, withCommandSignal, waitForCommand, shellQuote, writeJsonAtomic, type AgentsInTheCloudEventBus, type CommandInput, type JsonObject } from "@agents-in-the-cloud/core";
import { runHostObservableCommand, stripTerminalControls, tailTerminalText } from "@agents-in-the-cloud/observable-terminal/server";
import { errorMessage, isWorkspaceAppPort, workspaceGatewayPort, type WorkspaceGateway, type WorkspaceHttpAppBackend, type WorkspaceServerProvisioningHook } from "@agents-in-the-cloud/shared";
import { inspectWorkspaceImage, resolveWorkspaceImage } from "@agents-in-the-cloud/workspace-image";
import { prepareWorkspaceSystemd } from "./systemd.ts";
import { closeWorkspaceHelperConnection, requireRootInWorkspace, runInWorkspace, startLegacyWorkspaceHelper, workspaceHelperSocketPath, workspaceParentSocketDirectory } from "./helper.ts";
import { workspaceHelperCliPath } from "@agents-in-the-cloud/workspace-helper";
import { createWorkspaceContainerLifecycle, workspaceConfigurationLabel } from "./container-lifecycle.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { applySeedConfigManifest } from "./seed-config.ts";
import type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan, WorkspaceInitInstruction } from "./types.ts";
export type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan, WorkspaceInitInstruction, WorkspaceInitInstructionMap } from "./types.ts";

export { runInWorkspace, startInWorkspace } from "./helper.ts";
export { exitStatus as workspaceExitStatus } from "@agents-in-the-cloud/workspace-helper";
export { createWorkspaceMetadataState, type WorkspaceMetadataState } from "./metadata-state.ts";
export { ensureHostInotifyLimit } from "./host-inotify.ts";
export { createWorkspaceProvisioning, type WorkspaceProvisioning, type WorkspaceProvisionRun } from "./provisioning.ts";
import type { WorkspaceProvisionRun, WorkspaceProvisionProgress } from "./provisioning.ts";

export {
  createWorkspacePresentationStore,
  type WorkspaceWorkViewReference,
  type WorkspaceWorkViewState,
} from "./presentation.ts";

const workspaceTypeLabel = "com.agents-in-the-cloud.type";
const namespaceLabel = "com.agents-in-the-cloud.namespace";
const workspaceIdLabel = "com.agents-in-the-cloud.workspace-id";
const titlePath = "title";
const parkedPath = "parked";
const initPath = "init.json";
const workspaceManifestPath = ".agents-in-the-cloud/workspace.json";
const workspaceStartupTimeoutMs = 5 * 60_000;
const withWorkspaceIdentityLock = createProcessFileLock({
  label: "workspace identity tombstone",
  lockDir: () => agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", "identity-tombstones.lock"),
});
const dockerLabelsSchema = Type.Record(Type.String(), Type.String());
const nonBlankStringSchema = Type.String({ pattern: "\\S" });
const stringArraySchema = Type.Array(Type.String());
export const workspaceRoot = "/work";
// Reserved for VS Code. The adapter still verifies ownership before using it.
export const workspaceVSCodePort = 24800;

interface WorkspaceListResult { workspaces: Array<{ id: string; title: string | null; parked?: boolean; init?: WorkspaceInitInstruction; imageOutdated?: boolean }> }
export interface WorkspaceExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number }
type WorkspaceExecBufferResult = Omit<WorkspaceExecResult, "stdout"> & { stdout: Buffer }
export interface WorkspaceCommandOptions { workdir?: string; user?: "agents-in-the-cloud" | "root"; stdin?: CommandInput }
interface DeleteWorkspaceOptions { force?: boolean; events?: AgentsInTheCloudEventBus }

function namespace(): string { return process.env.ATELIER_NAMESPACE || "host"; }
export function generateWorkspaceId(): string { return crypto.randomUUID().replaceAll("-", "").slice(0, 8); }
export function workspaceContainerName(id: string): string { return `agents-in-the-cloud-${id}`; }

function workspaceNetworkName(id: string): string { return `agents-in-the-cloud-workspace-${id}`; }
export function workspaceBridgeName(id: string): string { return `atw-${createHash("sha256").update(id).digest("hex").slice(0, 11)}`; }
function formatDeleteBlockedMessage(id: string, issues: JsonObject[]): string { return `workspace ${id} has delete blockers:\n${issues.map((issue) => `- ${JSON.stringify(issue)}`).join("\n")}\nuse --force to delete anyway`; }

async function createWorkspaceWorkDir(id: string): Promise<{ worktreePath: string; dockerHostWorktreePath: string }> {
  const runtime = getAgentsInTheCloudRuntimeContext();
  const worktreePath = agentsInTheCloudDataPath(runtime, "workspaces", id, "work");
  const dockerHostWorktreePath = dockerHostAgentsInTheCloudDataPath(runtime, "workspaces", id, "work");
  if (await Bun.file(worktreePath).exists()) throw new AgentsInTheCloudCoreError("workspace_source_exists", `workspace source already exists: ${worktreePath}`);
  await mkdir(worktreePath, { recursive: true });
  return { worktreePath, dockerHostWorktreePath };
}

async function deleteWorkspaceWorkDir(id: string): Promise<void> {
  const runtime = getAgentsInTheCloudRuntimeContext();
  await rm(agentsInTheCloudDataPath(runtime, "workspaces", id), { recursive: true, force: true });
}

async function inspectLabels(id: string): Promise<Record<string, string>> {
  const inspected = await runDocker(["inspect", "--format", "{{json .Config.Labels}}", workspaceContainerName(id)]);
  if (inspected.exitCode !== 0) throw new AgentsInTheCloudCoreError("workspace_not_found", `workspace not found: ${id}`);
  const trimmed = inspected.stdout.trim();
  return trimmed && trimmed !== "null" ? Value.Parse(dockerLabelsSchema, JSON.parse(trimmed)) : {};
}

async function ensureWorkspaceFilesystem(id: string): Promise<void> {
  const result = await runInWorkspace(id, { argv: ["sh", "-c", `test -d ${shellQuote(workspaceRoot)} && test -d /.agents-in-the-cloud`], user: "root" });
  if (result.exitCode !== 0) throw new AgentsInTheCloudCoreError("workspace_repair_failed", result.stderr.trim() || result.stdout.toString().trim() || `workspace filesystem is not ready for ${id}`);
}

async function waitForWorkspaceStartup(id: string): Promise<string> {
  const timeoutSeconds = Math.ceil(workspaceStartupTimeoutMs / 1000);
  // The helper starts with the container, so wait for it rather than failing at once.
  const result = await runInWorkspace(id, { argv: ["sh", "-c", `deadline=$(( $(date +%s) + ${timeoutSeconds} )); while [ "$(date +%s)" -le "$deadline" ]; do if test -f /.agents-in-the-cloud/ready; then cat /.agents-in-the-cloud/startup.log; exit 0; fi; if test -S /run/systemd/private && systemctl is-failed --quiet agents-in-the-cloud-tmux.service agents-in-the-cloud-init.service agents-in-the-cloud-gateway.service; then break; fi; sleep 0.05; done; tail -n 120 /.agents-in-the-cloud/startup.log; journalctl --no-pager -n 120 -u agents-in-the-cloud-tmux.service -u agents-in-the-cloud-init.service -u agents-in-the-cloud-gateway.service; exit 1`], user: "root" }, { waitForReady: true, signal: AbortSignal.timeout(workspaceStartupTimeoutMs + 30_000) });
  const log = result.stdout.toString().trim();
  if (result.exitCode === 0) return log;
  const output = result.stderr.trim();
  throw new AgentsInTheCloudCoreError("workspace_startup_timeout", `workspace did not finish startup: ${id}${output ? `\n${output}` : ""}${log ? `\n\nStartup log:\n${log}` : ""}`);
}

async function validateWorkspaceContainer(id: string): Promise<Record<string, string>> {
  assertValidWorkspaceId(id);
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) throw new AgentsInTheCloudCoreError("workspace_not_found", `workspace not found: ${id}`);
  return labels;
}

export async function resolveWorkspace(id: string): Promise<string> {
  await validateWorkspaceContainer(id);
  await ensureWorkspaceFilesystem(id);
  return id;
}

export async function isWorkspaceRunning(id: string): Promise<boolean> {
  await validateWorkspaceContainer(id);
  const result = await runDocker(["inspect", "--format", "{{.State.Running}}", workspaceContainerName(id)]);
  if (result.exitCode !== 0) throw new AgentsInTheCloudCoreError("workspace_not_found", `workspace not found: ${id}`);
  return result.stdout.trim() === "true";
}

function assertValidWorkspaceId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
}

function workspaceIdentityTombstonePath(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", "identity-tombstones.json");
}

async function readRetiredWorkspaceIds(): Promise<Set<string>> {
  const text = await readTextIfExists(workspaceIdentityTombstonePath());
  if (text === undefined) return new Set();
  return new Set(Value.Parse(stringArraySchema, JSON.parse(text)));
}

function workspaceIdentityKey(id: string): string {
  return `${namespace()}\0${id}`;
}

async function isRetiredWorkspaceId(id: string): Promise<boolean> {
  return await withWorkspaceIdentityLock(async () => (await readRetiredWorkspaceIds()).has(workspaceIdentityKey(id)));
}

async function retireWorkspaceId(id: string): Promise<void> {
  await withWorkspaceIdentityLock(async () => {
    const retired = await readRetiredWorkspaceIds();
    retired.add(workspaceIdentityKey(id));
    await writeJsonAtomic(workspaceIdentityTombstonePath(), [...retired].sort());
  });
}

export function workspaceWorkHostPath(id: string): string {
  assertValidWorkspaceId(id);
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id, "work");
}

function workspaceMetadataDir(context: Awaited<ReturnType<typeof getAgentsInTheCloudRuntimeContext>>, id: string): string {
  return agentsInTheCloudDataPath(context, "workspaces", id, "metadata");
}

function workspaceMetadataPath(context: Awaited<ReturnType<typeof getAgentsInTheCloudRuntimeContext>>, id: string, name: string): string {
  return join(workspaceMetadataDir(context, id), name);
}

async function readTitle(context: Awaited<ReturnType<typeof getAgentsInTheCloudRuntimeContext>>, id: string): Promise<string | null> {
  const file = Bun.file(workspaceMetadataPath(context, id, titlePath));
  if (!(await file.exists())) return null;
  return (await file.text()).replace(/\n$/, "");
}

async function readParked(context: Awaited<ReturnType<typeof getAgentsInTheCloudRuntimeContext>>, id: string): Promise<boolean> {
  return await Bun.file(workspaceMetadataPath(context, id, parkedPath)).exists();
}

async function writeWorkspaceInit(context: Awaited<ReturnType<typeof getAgentsInTheCloudRuntimeContext>>, id: string, init: WorkspaceInitInstruction | undefined): Promise<void> {
  if (init === undefined) return;
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  await writeFile(workspaceMetadataPath(context, id, initPath), `${JSON.stringify(init, null, 2)}\n`);
}

export async function getWorkspaceInit(id: string): Promise<WorkspaceInitInstruction | undefined> {
  await resolveWorkspace(id);
  return await readWorkspaceInit(getAgentsInTheCloudRuntimeContext(), id);
}

async function readWorkspaceInit(context: Awaited<ReturnType<typeof getAgentsInTheCloudRuntimeContext>>, id: string): Promise<WorkspaceInitInstruction | undefined> {
  const file = Bun.file(workspaceMetadataPath(context, id, initPath));
  if (!(await file.exists())) return undefined;
  // SAFETY: This internal file serializes the open, declaration-merged
  // WorkspaceInitInstruction union; feature consumers validate concrete variants.
  return JSON.parse(await file.text()) as WorkspaceInitInstruction;
}

export interface RepoWorkspaceManifest {
  version: 1;
  initScripts?: string[];
  seedPiConfig?: {
    authJson?: string;
    modelsJson?: string;
    modelsStoreJson?: string;
  };
  seedAgentsInTheCloudConfig?: {
    projectsJson?: string;
  };
}

function optionalString(record: JsonObject, key: string, path: string, label = key): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Value.Check(nonBlankStringSchema, value)) throw invalidArguments(`invalid ${path}: ${label} must be a non-empty string`);
  return value;
}

function optionalRecord(record: JsonObject, key: string, path: string): JsonObject | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw invalidArguments(`invalid ${path}: ${key} must be an object`);
  return value;
}

export function parseRepoWorkspaceManifest(text: string, path = workspaceManifestPath): RepoWorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidArguments(`invalid ${path}: ${errorMessage(error)}`);
  }
  if (!isJsonObject(parsed)) throw invalidArguments(`invalid ${path}: expected object`);
  const record = parsed;
  if (record.version !== 1) throw invalidArguments(`invalid ${path}: unsupported version`);
  if (record.privileged !== undefined) throw invalidArguments(`invalid ${path}: privileged is no longer supported; use template settings`);
  if (record.isAgentsInTheCloud !== undefined) throw invalidArguments(`invalid ${path}: isAgentsInTheCloud is no longer supported`);
  if (record.docker !== undefined) throw invalidArguments(`invalid ${path}: docker settings are no longer supported; use template settings`);
  const initScripts = record.initScripts;
  if (initScripts !== undefined && !Value.Check(stringArraySchema, initScripts)) throw invalidArguments(`invalid ${path}: initScripts must be an array of strings`);
  const seedPiConfigRecord = optionalRecord(record, "seedPiConfig", path);
  const authJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "authJson", path, "seedPiConfig.authJson") : undefined;
  const modelsJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "modelsJson", path, "seedPiConfig.modelsJson") : undefined;
  const modelsStoreJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "modelsStoreJson", path, "seedPiConfig.modelsStoreJson") : undefined;
  const seedAgentsInTheCloudConfigRecord = optionalRecord(record, "seedAgentsInTheCloudConfig", path);
  const workspaceTemplatesJson = seedAgentsInTheCloudConfigRecord ? optionalString(seedAgentsInTheCloudConfigRecord, "projectsJson", path, "seedAgentsInTheCloudConfig.projectsJson") : undefined;
  const manifest: RepoWorkspaceManifest = { version: 1 };
  if (initScripts) manifest.initScripts = initScripts;
  if (seedPiConfigRecord) {
    manifest.seedPiConfig = {};
    if (authJson) manifest.seedPiConfig.authJson = authJson;
    if (modelsJson) manifest.seedPiConfig.modelsJson = modelsJson;
    if (modelsStoreJson) manifest.seedPiConfig.modelsStoreJson = modelsStoreJson;
  }
  if (seedAgentsInTheCloudConfigRecord) {
    manifest.seedAgentsInTheCloudConfig = {};
    if (workspaceTemplatesJson) manifest.seedAgentsInTheCloudConfig.projectsJson = workspaceTemplatesJson;
  }
  return manifest;
}

async function readRepoWorkspaceManifest(sourcePath: string): Promise<RepoWorkspaceManifest | undefined> {
  const file = Bun.file(join(sourcePath, workspaceManifestPath));
  if (!(await file.exists())) return undefined;
  return parseRepoWorkspaceManifest(await file.text(), workspaceManifestPath);
}

async function applyRepoWorkspaceManifest(workspaceId: string, sourcePath: string, plan: WorkspaceDockerPlan): Promise<void> {
  const manifest = await readRepoWorkspaceManifest(sourcePath);
  if (!manifest) return;
  const runtime = getAgentsInTheCloudRuntimeContext();
  await applySeedConfigManifest(manifest, plan, runtime, agentsInTheCloudDataPath(runtime, "workspaces", workspaceId, "seed-config"));
  plan.initScripts.push(...(manifest.initScripts ?? []));
}

export async function execWorkspaceCommand(id: string, command: string[], options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> {
  const result = await execWorkspaceCommandBuffer(id, command, options);
  return { ...result, stdout: result.stdout.toString() };
}
export async function execWorkspaceCommandBuffer(id: string, command: string[], options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecBufferResult> {
  if (command.length === 0) throw invalidArguments("command is required");
  const resolved = await resolveWorkspace(id);
  const startedAt = Date.now();
  const result = await runInWorkspace(resolved, { argv: command, user: options.user ?? "agents-in-the-cloud", workdir: options.workdir ?? workspaceRoot }, { stdin: options.stdin });
  return { ...result, durationMs: Date.now() - startedAt };
}
export async function execWorkspaceShell(id: string, script: string, options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> { return await execWorkspaceCommand(id, ["sh", "-lc", script], options); }

const workspaceSetupScript = ".agents-in-the-cloud/setup.sh";
export const workspaceSetupProvisioningHook: WorkspaceServerProvisioningHook = {
  id: "workspace.setup",
  label: "Run repository setup",
  recovery: "continue",
  async run({ workspaceId: id, events }) {
    if (!(await Bun.file(join(workspaceWorkHostPath(id), workspaceSetupScript)).exists())) {
      await events?.emit("workspace_provision_progress", { workspaceId: id, detail: `No ${workspaceSetupScript}` });
      return;
    }

    const session = `agents-in-the-cloud-provision-setup-${crypto.randomUUID().slice(0, 8)}`;
    const result = await runHostObservableCommand({
      session,
      cwd: "/",
      command: [process.execPath, workspaceHelperCliPath, workspaceHelperSocketPath(id), "agents-in-the-cloud", workspaceRoot, "sh", workspaceSetupScript].map(shellQuote).join(" "),
      onSessionStarted: async () => {
        await events?.emit("workspace_provision_progress", { workspaceId: id, terminalSession: session });
      },
    });
    const output = tailTerminalText(stripTerminalControls(result.output));
    await events?.emit("workspace_provision_progress", { workspaceId: id, output });
    if (result.exitCode !== 0) throw new AgentsInTheCloudCoreError("workspace_setup_failed", output || `${workspaceSetupScript} failed with exit code ${result.exitCode}`);
  },
};

function dockerMountArg(mount: WorkspaceDockerMount): string {
  return [`type=${mount.type}`, ...(mount.source === undefined ? [] : [`src=${mount.source}`]), `dst=${mount.target}`, ...(mount.readonly ? ["readonly"] : [])].join(",");
}

function planEnvDockerArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function workspaceCreateDockerArgs(container: string, image: string, plan: WorkspaceDockerPlan): string[] {
  return [
    "create",
    "--restart", "unless-stopped",
    "--name", container,
    ...Object.entries(plan.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
    "--network", workspaceNetworkName(plan.labels[workspaceIdLabel]!),
    ...planEnvDockerArgs(plan.env),
    ...plan.extraArgs,
    ...plan.mounts.flatMap((mount) => ["--mount", dockerMountArg(mount)]),
    "--user", "root",
    image,
    "/usr/local/bin/agents-in-the-cloud-workspace-init",
  ];
}

function workspaceGitCredentialInitScript(): string {
  return `cat > /usr/local/bin/agents-in-the-cloud-git-credential <<'EOF'
#!/bin/sh
${gitCredentialHelperShellBody}
EOF
chmod 755 /usr/local/bin/agents-in-the-cloud-git-credential
git config --system credential.helper '!/usr/local/bin/agents-in-the-cloud-git-credential'`;
}

interface WorkspaceEnvironment {
  [name: string]: string;
}

function hostUserEnv(): WorkspaceEnvironment {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new AgentsInTheCloudCoreError("unsupported_platform", "workspace containers require a POSIX host uid/gid");
  if (uid === 0 || gid === 0) throw new AgentsInTheCloudCoreError("unsupported_root_user", "workspace containers require a non-root AgentsInTheCloud process");
  return { ATELIER_HOST_UID: String(uid), ATELIER_HOST_GID: String(gid) };
}

function baseWorkspacePlan(labels: Record<string, string>): WorkspaceDockerPlan {
  return { labels, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...hostUserEnv() }, mounts: [], preloadImages: [], extraArgs: [], initScripts: [workspaceGitCredentialInitScript()], containerFiles: [], cleanup: [] };
}

function alignWorkspaceUserScript(): string {
  return `work_uid="\${ATELIER_HOST_UID:?}"
work_gid="\${ATELIER_HOST_GID:?}"
if [ "$work_uid" = 0 ] || [ "$work_gid" = 0 ]; then echo "AgentsInTheCloud must run as a non-root host user" >&2; exit 1; fi
conflict_user="$(getent passwd "$work_uid" | cut -d: -f1 || true)"
if [ -n "$conflict_user" ] && [ "$conflict_user" != agents-in-the-cloud ]; then userdel "$conflict_user"; fi
if [ "$(id -u agents-in-the-cloud)" != "$work_uid" ] || [ "$(id -g agents-in-the-cloud)" != "$work_gid" ]; then
  # Do not replace this with usermod/groupmod without profiling workspace startup.
  # The shared home already belongs to the host user; never recursively chown it.
  sed -i -E "s/^(agents-in-the-cloud:[^:]*:)[0-9]+:[0-9]+:/\\1\${work_uid}:\${work_gid}:/" /etc/passwd
  sed -i -E "s/^(agents-in-the-cloud:[^:]*:)[0-9]+:/\\1\${work_gid}:/" /etc/group
  if [ -d /.agents-in-the-cloud/vscode ]; then chown -R agents-in-the-cloud:agents-in-the-cloud /.agents-in-the-cloud/vscode; fi
  # VS Code writes its extensions manifest here, outside the home directory.
  # Keep installed extensions writable after aligning the image user to the host.
  if [ -d /opt/agents-in-the-cloud/vscode-extensions ]; then chown -R agents-in-the-cloud:agents-in-the-cloud /opt/agents-in-the-cloud/vscode-extensions; fi
fi
chown agents-in-the-cloud:agents-in-the-cloud /.agents-in-the-cloud`;
}

function workspaceStartupPreambleScript(): string {
  return `set -eu
mkdir -p /.agents-in-the-cloud
rm -f /.agents-in-the-cloud/ready
startup_started_at_ms="$(($(date +%s%N) / 1000000))"
startup_log_path=/.agents-in-the-cloud/startup.log
: > "$startup_log_path"
startup_now_ms() { now_ns="$(date +%s%N)"; echo "$((now_ns / 1000000))"; }
startup_log_step() { now_ms="$(startup_now_ms)"; printf '%s +%sms %s\\n' "$now_ms" "$((now_ms - startup_started_at_ms))" "$1" >> "$startup_log_path"; }
startup_log_failure() { status=$?; if [ "$status" -ne 0 ]; then startup_log_step "failed status=$status"; fi; }
trap startup_log_failure EXIT
startup_log_step start`;
}

function workspaceInitStepScript(id: string, script: string): string {
  return `startup_log_step ${shellQuote(`${id}.start`)}
{ ${script}
}
startup_log_step ${shellQuote(`${id}.done`)}`;
}

function workspaceInitScript(plan: WorkspaceDockerPlan): string {
  return [
    workspaceStartupPreambleScript(),
    workspaceInitStepScript("gateway-credential", "chown root:root /etc/agents-in-the-cloud-workspace-gateway-token; chmod 600 /etc/agents-in-the-cloud-workspace-gateway-token"),
    workspaceInitStepScript("align-user", alignWorkspaceUserScript()),
    workspaceInitStepScript("agents-in-the-cloud-dir", `install -d -o agents-in-the-cloud -g agents-in-the-cloud /.agents-in-the-cloud`),
    // Start after UID/GID alignment, before repository hooks can create sessions.
    workspaceInitStepScript("tmux", "systemctl start agents-in-the-cloud-tmux.service"),
    ...plan.initScripts.map((script, index) => workspaceInitStepScript(`init-${index + 1}`, script)),
    "startup_log_step gateway.start",
    "trap - EXIT",
  ].join("\n");
}

export async function createWorkspace(options: { id: string; events: AgentsInTheCloudEventBus; init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; run: WorkspaceProvisionRun }): Promise<void> {
  const { id, events, run } = options;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
  if (await isRetiredWorkspaceId(id)) throw invalidArguments(`workspace id has been permanently retired and cannot be reused: ${id}`);
  const context = options.context && Object.keys(options.context).length ? options.context : undefined;
  const init = options.init;
  const source = await run.step("workspace.workdir", "Create workspace directory", () => createWorkspaceWorkDir(id));
  let plan: WorkspaceDockerPlan | undefined;
  try {
    await run.step("workspace.source", "Prepare workspace source", async () => {
      await writeWorkspaceInit(getAgentsInTheCloudRuntimeContext(), id, init);
      await events.emit("workspace_source_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot });
    }, "retry");
    const activePlan = await run.step("workspace.plan", "Prepare workspace container plan", async () => {
      const labels = { [workspaceTypeLabel]: "workspace", [namespaceLabel]: namespace(), [workspaceIdLabel]: id, [workspaceConfigurationLabel]: "1" } satisfies Record<string, string>;
      const activePlan = baseWorkspacePlan(labels);
      plan = activePlan;
      const gatewayTokenPath = agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id, "gateway-token");
      await writeFile(gatewayTokenPath, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 });
      activePlan.containerFiles.push({ source: gatewayTokenPath, target: "/etc/agents-in-the-cloud-workspace-gateway-token" });
      activePlan.mounts.push({ type: "bind", source: source.dockerHostWorktreePath, target: workspaceRoot });
      activePlan.mounts.push(...await workspaceHomeMounts(id));
      const sockets = agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspace-sockets", id);
      await mkdir(sockets, { recursive: true });
      activePlan.mounts.push({ type: "volume", target: "/data" });
      activePlan.mounts.push({ type: "bind", source: "/data/erofs-cache", target: "/data/erofs-cache", readonly: true });
      // Writable so the workspace helper can listen here too.
      activePlan.mounts.push({ type: "bind", source: dockerHostAgentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspace-sockets", id), target: workspaceParentSocketDirectory });
      await events.emit("workspace_plan_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot, plan: activePlan });
      // Host modules authorize seeding before any repository-requested config is exported.
      await applyRepoWorkspaceManifest(id, source.worktreePath, activePlan);
      // Gate once, after all modules have contributed their image requests.
      if (!activePlan.privileged) activePlan.preloadImages = [];
      return activePlan;
    });
    if (!activePlan.image) {
      activePlan.image = await run.step("workspace.image", "Resolve workspace image", async () => {
        const configuration: WorkspaceImageConfigureEvent = { init };
        await events.emit("workspace_image_configure", configuration);
        return resolveWorkspaceImage({ workspaceId: id, events, sourcePath: source.worktreePath, dockerfile: configuration.dockerfile });
      });
    }
    const defaultWorkspaceFile = await run.step("workspace.preload-resolve", "Save configured preload images", () => workspaceImagePreloader.snapshot(activePlan.preloadImages, agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id)));
    if (defaultWorkspaceFile) activePlan.containerFiles.push({ source: dirname(defaultWorkspaceFile), target: "/etc" });
    await run.step("workspace.container", "Create workspace container", async () => {
      await prepareWorkspaceSystemd(activePlan, agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id, "systemd"), workspaceInitScript(activePlan));
      const image = activePlan.image;
      if (!image) throw new AgentsInTheCloudCoreError("workspace_image_missing", "workspace image was not resolved");
      const container = workspaceContainerName(id);
      await workspaceContainerLifecycle(id, true).snapshot(activePlan.containerFiles);
      await requireDocker(["network", "create", "--driver", "bridge", "--opt", `com.docker.network.bridge.name=${workspaceBridgeName(id)}`, "--label", `${workspaceTypeLabel}=workspace-network`, "--label", `${workspaceIdLabel}=${id}`, workspaceNetworkName(id)]);
      await requireDocker(workspaceCreateDockerArgs(container, image, activePlan));
    });
    await run.step("workspace.startup", "Initialize workspace", async () => {
      const log = await ensureWorkspaceStarted(id);
      run.report({ output: log });
    }, "retry");
    await run.step("workspace.readiness", "Prepare workspace", async () => {
      await checkWorkspaceReadiness(id, (detail) => run.report({ detail }), (progress) => run.report(progress));
    }, "retry-or-continue");
  } catch (error) {
    // Cancellation hands ownership to deletion, which reviews files before removing them.
    if (run.signal.aborted) throw error;
    try {
      const removed = await runDocker(["rm", "-f", "--volumes", workspaceContainerName(id)]);
      if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) throw new Error(removed.stderr.trim() || "could not remove failed workspace container");
      const networks = await requireDocker(["network", "ls", "--quiet", "--filter", `name=^${workspaceNetworkName(id).replaceAll(".", "\\.")}$`]);
      if (networks.stdout.trim()) await requireDocker(["network", "rm", workspaceNetworkName(id)]);
      await events.emit("workspace_deleted", { workspaceId: id });
      await rm(agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspace-sockets", id), { recursive: true, force: true });
      closeWorkspaceHelperConnection(id);
      await Promise.all((plan?.cleanup ?? []).map((cleanup) => cleanup()));
      await deleteWorkspaceWorkDir(id);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `workspace ${id} provisioning and cleanup failed; ownership records retained`);
    }
    throw error;
  }
}

const workspaceGatewayCache = new Map<string, Promise<WorkspaceGateway>>();

function workspaceGatewayCacheKey(id: string): string {
  return `${namespace()}\0${id}`;
}

async function inspectWorkspaceGateway(id: string): Promise<WorkspaceGateway> {
  await resolveWorkspace(id);
  const result = await requireDocker(["inspect", "--format", `{{with index .NetworkSettings.Networks "${workspaceNetworkName(id)}"}}{{.IPAddress}}{{end}}`, workspaceContainerName(id)]);
  const address = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new AgentsInTheCloudCoreError("workspace_gateway_unavailable", `Workspace ${id} has no address on its dedicated network`);
  const token = await readFile(agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id, "gateway-token"), "utf8");
  return { url: new URL(`http://${address}:${workspaceGatewayPort}`), token };
}

async function workspaceGateway(id: string): Promise<WorkspaceGateway> {
  const key = workspaceGatewayCacheKey(id);
  let gateway = workspaceGatewayCache.get(key);
  if (!gateway) {
    gateway = withCommandSignal(AbortSignal.timeout(30_000), () => inspectWorkspaceGateway(id)).catch((error) => {
      workspaceGatewayCache.delete(key);
      throw error;
    });
    workspaceGatewayCache.set(key, gateway);
  }
  return await waitForCommand(gateway);
}

/** Resolve any workspace-local web app through the workspace gateway on its dedicated bridge. */
export async function workspacePortBackend(id: string, port: number, pathAndSearch: string, protocol = "http:"): Promise<WorkspaceHttpAppBackend> {
  if (!isWorkspaceAppPort(port)) throw invalidArguments(`Invalid workspace app port ${port}: use 1–65535, except reserved gateway port ${workspaceGatewayPort}`);
  if (protocol !== "http:" && protocol !== "https:") throw invalidArguments("Workspace apps must use HTTP or HTTPS");
  const path = pathAndSearch.startsWith("/") ? pathAndSearch : `/${pathAndSearch}`;
  // Concatenation, not URL resolution: // in an app path must never change hosts.
  const target = new URL(`${protocol}//127.0.0.1:${port}${path}`);
  return { kind: "http", target, gateway: await workspaceGateway(id) };
}

export async function workspaceImageOutdated(id: string, container = workspaceContainerName(id), events?: AgentsInTheCloudEventBus): Promise<boolean> {
  const configuration: WorkspaceImageConfigureEvent = { init: await readWorkspaceInit(getAgentsInTheCloudRuntimeContext(), id) };
  await events?.emit("workspace_image_configure", configuration);
  const [expectedImageId, actualImage] = await Promise.all([
    inspectWorkspaceImage({ sourcePath: workspaceWorkHostPath(id), dockerfile: configuration.dockerfile }),
    requireDocker(["inspect", "--format", "{{.Image}}", container]),
  ]);
  return expectedImageId === undefined || actualImage.stdout.trim() !== expectedImageId;
}

/** Discovery can skip image inspection so server startup only reads workspace identity. */
export async function listWorkspaces(options: { inspectImages?: boolean; events?: AgentsInTheCloudEventBus } = {}): Promise<WorkspaceListResult> {
  const context = getAgentsInTheCloudRuntimeContext();
  const listed = await requireDocker(["ps", "-a", "--filter", `label=${workspaceTypeLabel}=workspace`, "--filter", `label=${namespaceLabel}=${namespace()}`, "--format", `{{.ID}}\t{{.Label "${workspaceIdLabel}"}}`]);
  const workspaces = await Promise.all(listed.stdout.trim().split(/\n+/).filter(Boolean).map(async (line) => {
    const [containerId, labelledId] = line.split("\t");
    const id = labelledId?.trim() || containerId!.slice(0, 8);
    const [parked, init, title, imageOutdated] = await Promise.all([
      readParked(context, id),
      readWorkspaceInit(context, id),
      readTitle(context, id),
      options.inspectImages === false ? false : workspaceImageOutdated(id, containerId, options.events),
    ]);
    const workspace: WorkspaceListResult["workspaces"][number] = { id, title };
    if (parked) workspace.parked = parked;
    if (init !== undefined) workspace.init = init;
    if (imageOutdated) workspace.imageOutdated = imageOutdated;
    return workspace;
  }));
  return { workspaces };
}

export async function deleteWorkspace(id: string, options: DeleteWorkspaceOptions = {}): Promise<null> {
  assertValidWorkspaceId(id);
  let containerExists = true;
  if (options.force) {
    const labels = await inspectLabels(id).catch((error) => {
      if (error instanceof AgentsInTheCloudCoreError && error.code === "workspace_not_found") return undefined;
      throw error;
    });
    if (labels && (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace())) throw new AgentsInTheCloudCoreError("workspace_not_found", `workspace not found: ${id}`);
    containerExists = labels !== undefined;
  } else {
    await resolveWorkspace(id);
    const issues: JsonObject[] = [];
    await options.events?.emit("workspace_delete_inspect", { workspaceId: id, issues });
    if (issues.length > 0) throw new AgentsInTheCloudCoreError("workspace_delete_blocked", formatDeleteBlockedMessage(id, issues), { workspaceId: id, issues });
  }
  // Join workspace consumers while their container and persisted files still exist.
  await options.events?.emit("workspace_deleting", { workspaceId: id });
  if (containerExists) await requireDocker(["rm", "-f", "--volumes", workspaceContainerName(id)]);
  const networks = await requireDocker(["network", "ls", "--quiet", "--filter", `name=^${workspaceNetworkName(id).replaceAll(".", "\\.")}$`]);
  if (networks.stdout.trim()) await requireDocker(["network", "rm", workspaceNetworkName(id)]);
  await retireWorkspaceId(id);
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
  await options.events?.emit("workspace_deleted", { workspaceId: id });
  await rm(agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspace-sockets", id), { recursive: true, force: true });
  closeWorkspaceHelperConnection(id);
  await deleteWorkspaceWorkDir(id);
  return null;
}

export async function getWorkspaceTitle(id: string): Promise<string | null> {
  await resolveWorkspace(id);
  return await readTitle(getAgentsInTheCloudRuntimeContext(), id);
}

export async function setWorkspaceTitle(id: string, title: string): Promise<null> {
  await resolveWorkspace(id);
  const context = getAgentsInTheCloudRuntimeContext();
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  await writeFile(workspaceMetadataPath(context, id, titlePath), title);
  return null;
}

function workspaceContainerLifecycle(id: string, checkpointRequired: boolean) {
  return createWorkspaceContainerLifecycle({
    directory: agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id, "configuration"),
    container: workspaceContainerName(id), checkpointRequired,
    started: () => startLegacyWorkspaceHelper(id, workspaceContainerName(id)),
    waitForStartup: () => waitForWorkspaceStartup(id),
  });
}

/** Complete interrupted configuration before starting; never rerun planning hooks. */
export async function ensureWorkspaceStarted(id: string): Promise<string> {
  const labels = await validateWorkspaceContainer(id);
  const lifecycle = workspaceContainerLifecycle(id, labels[workspaceConfigurationLabel] === "1");
  const log = await lifecycle.ensureStarted();
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
  return log;
}

/** Give the gateway 15 seconds to boot before reporting a recoverable startup failure. */
async function checkWorkspaceGateway(id: string): Promise<void> {
  await workspaceGateway(id);
  const result = await runInWorkspace(id, { argv: ["sh", "-c", `deadline=$(( $(date +%s) + 15 )); while [ "$(date +%s)" -lt "$deadline" ]; do if test "$(curl --noproxy '*' --silent --max-time 1 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:${workspaceGatewayPort}/)" = 401; then exit 0; fi; sleep 0.05; done; exit 1`], user: "root" });
  if (result.exitCode !== 0) throw new AgentsInTheCloudCoreError("workspace_gateway_unavailable", `Workspace gateway did not become ready within 15 seconds.${result.stderr.trim() ? `\n${result.stderr.trim()}` : ""}`);
}

export async function stopWorkspaceContainer(id: string): Promise<void> {
  await validateWorkspaceContainer(id);
  await requireDocker(["stop", "--time", "10", workspaceContainerName(id)]);
  closeWorkspaceHelperConnection(id);
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
}

export async function setWorkspaceParked(id: string, parked: boolean): Promise<null> {
  await validateWorkspaceContainer(id);
  const context = getAgentsInTheCloudRuntimeContext();
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  const path = workspaceMetadataPath(context, id, parkedPath);
  if (parked) {
    await writeFile(path, "");
    await stopWorkspaceContainer(id);
  } else {
    await ensureWorkspaceStarted(id);
    await rm(path, { force: true });
  }
  return null;
}

/** Repeated on resume and app recovery; the persisted list never rereads template settings. */
export async function checkWorkspaceReadiness(id: string, report: (detail: string) => void = () => {}, activity: (progress: WorkspaceProvisionProgress) => void = () => {}): Promise<void> {
  report("Checking workspace gateway");
  await checkWorkspaceGateway(id);
  for (const socket of ["ingress", "egress"]) {
    report(`Checking ${socket} proxy`);
    await requireRootInWorkspace(id, ["curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "5", "--unix-socket", `${workspaceParentSocketDirectory}/${socket}.sock`, "http://localhost/health"]);
  }
  report("Checking workspace image service");
  await requireRootInWorkspace(id, ["curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "5", "http://127.0.0.1:58124/health"]);
  report("Resolving required images");
  const images = await workspaceImagePreloader.load(agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "workspaces", id), report);
  await workspaceImagePreloader.install(images, id, report, activity);
}
