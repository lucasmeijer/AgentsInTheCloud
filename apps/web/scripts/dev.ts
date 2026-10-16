import { watch } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";


const cwd = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(cwd, "../..");
const packagesDir = resolve(repoRoot, "packages");

let building = false;
let dirty = false;
let fullBuildRequested = true;
let buildPromise: Promise<void> | undefined;
let timer: Timer | undefined;
let serverRestartTimer: Timer | undefined;
let workspaceImageTimer: Timer | undefined;
let workspaceHelperTimer: Timer | undefined;
let browserReloadTimer: Timer | undefined;
let browserReloadRevision = 0;
let workspaceImageEnsuring = false;
let workspaceImageDirty = false;
let server: ReturnType<typeof Bun.spawn> | undefined;
let stoppingServer = false;
const pendingRestartReasons = new Set<string>();
const devReloadFile = join("/tmp", `agents-in-the-cloud-dev-reload-${process.pid}.json`);
const devReloadTempFile = `${devReloadFile}.tmp`;

function scheduleBrowserReload(): void {
  if (browserReloadTimer) clearTimeout(browserReloadTimer);
  browserReloadTimer = setTimeout(() => void (async () => {
    browserReloadRevision += 1;
    await Bun.write(devReloadTempFile, `${JSON.stringify({ revision: browserReloadRevision })}\n`);
    await rename(devReloadTempFile, devReloadFile);
  })(), 150);
}

function prefixed(prefix: string, stream: ReadableStream<Uint8Array> | null): void {
  if (!stream) return;
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) console.log(`${prefix} ${line}`);
    }
    pending += decoder.decode();
    if (pending) console.log(`${prefix} ${pending}`);
  })();
}

async function runBuild(full = false): Promise<void> {
  if (full) fullBuildRequested = true;
  if (building) {
    dirty = true;
    await buildPromise;
    return;
  }

  buildPromise = (async () => {
    do {
      building = true;
      dirty = false;
      const fullBuild = fullBuildRequested;
      fullBuildRequested = false;
      console.log(`[assets] rebuilding${fullBuild ? "" : " client"}…`);
      const proc = Bun.spawn(["bun", "run", "build:assets", ...(fullBuild ? [] : ["--client-only"])], { cwd, stdout: "pipe", stderr: "pipe" });
      prefixed("[assets]", proc.stdout);
      prefixed("[assets]", proc.stderr);
      const code = await proc.exited;
      console.log(code === 0 ? "[assets] ready" : `[assets] failed (${code})`);
      if (code === 0) scheduleBrowserReload();
    } while (dirty);
    building = false;
    buildPromise = undefined;
  })();

  await buildPromise;
}

function scheduleBuild(full: boolean): void {
  if (full) fullBuildRequested = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runBuild(), 100);
}

function ignored(path: string): boolean {
  const normalized = resolve(path);
  return normalized.includes(`${sep}node_modules${sep}`)
    || normalized.includes(`${sep}.git${sep}`)
    || normalized.includes(`${sep}apps${sep}web${sep}public${sep}assets${sep}`)
    || normalized.endsWith(`${sep}apps${sep}web${sep}public${sep}assets-manifest.json`)
    || normalized.includes(`${sep}apps${sep}web${sep}public${sep}.assets-manifest-`)
    || normalized.endsWith(`${sep}apps${sep}web${sep}src${sep}client${sep}workspace-client-modules.generated.ts`)
    || normalized.endsWith(`${sep}apps${sep}web${sep}src${sep}server${sep}workspace-modules.generated.ts`);
}

function formatChangedPath(path: string): string {
  const rel = relative(repoRoot, path);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : path;
}

function rememberRestartReason(reason: string, changed: string): void {
  pendingRestartReasons.add(`${reason}: ${formatChangedPath(changed)}`);
}

function describeRestartReasons(): string {
  const reasons = [...pendingRestartReasons];
  pendingRestartReasons.clear();
  if (reasons.length === 0) return "manual restart";
  const shown = reasons.slice(0, 10);
  const suffix = reasons.length > shown.length ? ` (and ${reasons.length - shown.length} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function packageRelativePath(path: string): string | undefined {
  const rel = relative(packagesDir, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel;
}

function isPackageRuntimeChange(path: string): boolean {
  const rel = packageRelativePath(path);
  if (!rel) return false;
  const [packageName, firstPackagePathPart] = rel.split(sep);
  return firstPackagePathPart === "package.json" || firstPackagePathPart === "src"
    || (packageName === "design-system" && firstPackagePathPart === "catalogue");
}

function isWorkspaceImageInputChange(path: string): boolean {
  const rel = packageRelativePath(path);
  if (!rel) return false;
  return rel.endsWith(`${sep}workspace-image.json`)
    || rel.startsWith(`workspace-image${sep}scripts${sep}`)
    || rel.startsWith(`workspace-image${sep}rootfs${sep}`)
    || rel === `workspace-image${sep}runtime-image`
    || rel === `workspace-image${sep}src${sep}workspace-systemd-units.ts`
    || rel.includes(`${sep}workspace-image${sep}`);
}

async function ensureWorkspaceImage(): Promise<void> {
  if (workspaceImageEnsuring) {
    workspaceImageDirty = true;
    return;
  }
  workspaceImageEnsuring = true;
  try {
    do {
      workspaceImageDirty = false;
      console.log("[workspace-image] ensuring default workspace image…");
      const ensure = Bun.spawn(["bun", join(repoRoot, "scripts/ensure-workspace-image.ts")], { cwd, stdout: "inherit", stderr: "inherit" });
      const code = await ensure.exited;
      if (code !== 0) throw new Error(`workspace image preparation failed (${code})`);
    } while (workspaceImageDirty);
  } finally {
    workspaceImageEnsuring = false;
  }
}

function scheduleWorkspaceImageEnsure(): void {
  if (workspaceImageTimer) clearTimeout(workspaceImageTimer);
  workspaceImageTimer = setTimeout(() => void ensureWorkspaceImage(), 250);
}

function isWorkspaceHelperChange(path: string): boolean {
  const rel = packageRelativePath(path);
  return rel !== undefined && (rel.startsWith(`workspace-helper${sep}helper${sep}`) || rel.startsWith(`workspace-helper${sep}proto${sep}`));
}

async function buildWorkspaceHelper(): Promise<boolean> {
  console.log("[workspace-helper] building…");
  const build = Bun.spawn(["bun", join(packagesDir, "workspace-helper/scripts/build.ts")], { cwd, stdout: "pipe", stderr: "pipe" });
  prefixed("[workspace-helper]", build.stdout);
  prefixed("[workspace-helper]", build.stderr);
  const code = await build.exited;
  console.log(code === 0 ? "[workspace-helper] ready" : `[workspace-helper] failed (${code})`);
  return code === 0;
}

function watchRecursive(path: string, onChange: (changed: string) => void): void {
  watch(path, { recursive: true }, (_event, filename) => {
    const changed = filename ? resolve(path, filename.toString()) : path;
    if (!ignored(changed)) onChange(changed);
  });
}

function startServer(): void {
  stoppingServer = false;
  const child = Bun.spawn(["bun", "run", "src/server/main.ts", `--agents-in-the-cloud-dev-reload-file=${devReloadFile}`], { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  server = child;
  void (async () => {
    const code = await child.exited;
    if (server === child) server = undefined;
    if (stoppingServer) return;
    console.error(`[server] exited (${code ?? 1}); waiting for a server source change`);
  })();
}

async function restartServer(): Promise<void> {
  const why = describeRestartReasons();
  if (!server) {
    console.log(`[server] starting (${why})`);
    startServer();
    scheduleBrowserReload();
    return;
  }
  console.log(`[server] restarting (${why})`);
  stoppingServer = true;
  const previous = server;
  previous.kill();
  const exited = await Promise.race([previous.exited.then(() => true), Bun.sleep(1500).then(() => false)]);
  if (!exited) {
    console.log("[server] graceful stop timed out; terminating old server");
    previous.kill("SIGKILL");
    await previous.exited;
  }
  startServer();
  scheduleBrowserReload();
}

function scheduleWorkspaceHelperBuild(changed: string): void {
  rememberRestartReason("workspace helper changed", changed);
  if (workspaceHelperTimer) clearTimeout(workspaceHelperTimer);
  // Workspaces get the new tools directory when the server starts.
  workspaceHelperTimer = setTimeout(() => void (async () => {
    if (await buildWorkspaceHelper()) await restartServer();
  })(), 250);
}

function scheduleServerRestart(reason: string, changed: string): void {
  rememberRestartReason(reason, changed);
  if (serverRestartTimer) clearTimeout(serverRestartTimer);
  serverRestartTimer = setTimeout(() => void restartServer(), 100);
}

function scheduleBuildThenServerRestart(reason: string, changed: string): void {
  rememberRestartReason(reason, changed);
  if (serverRestartTimer) clearTimeout(serverRestartTimer);
  if (timer) clearTimeout(timer);
  serverRestartTimer = setTimeout(() => void (async () => {
    await runBuild(true);
    await restartServer();
  })(), 100);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Bun.write(devReloadFile, `${JSON.stringify({ revision: browserReloadRevision })}\n`);
await runBuild(true);
if (!await buildWorkspaceHelper()) throw new Error("workspace helper build failed");
await ensureWorkspaceImage();

watchRecursive(resolve(cwd, "src/client"), () => scheduleBuild(false));
watchRecursive(resolve(cwd, "public"), () => scheduleBuild(true));
watchRecursive(resolve(cwd, "src/server"), (changed) => {
  if (changed.endsWith(`${sep}static-files.ts`)) scheduleBuildThenServerRestart("server static file list changed", changed);
  else scheduleServerRestart("server source changed", changed);
});
watchRecursive(resolve(repoRoot, "packages"), (changed) => {
  if (isWorkspaceImageInputChange(changed)) scheduleWorkspaceImageEnsure();
  if (isWorkspaceHelperChange(changed)) scheduleWorkspaceHelperBuild(changed);
  if (isPackageRuntimeChange(changed)) scheduleBuildThenServerRestart("shared package runtime changed", changed);
});

startServer();

function shutdown(): void {
  stoppingServer = true;
  server?.kill();
  void rm(devReloadFile, { force: true });
  void rm(devReloadTempFile, { force: true });
  process.exit(0);
}

await new Promise(() => {});
