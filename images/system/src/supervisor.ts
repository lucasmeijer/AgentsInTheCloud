import { tailscaleHttpsSettingsUrl, TailscaleHttpsDisabledError } from "../../../packages/shared/src/tailscale.ts";
import { hostSocketPath } from "../../../packages/host/src/protocol.ts";
import { startHostService } from "../../../packages/host/src/system/service.ts";
import { dirname } from "node:path";
import { escapeHtml } from "../../../packages/shared/src/html.ts";
import { startLocalIngress } from "./local-ingress.ts";
import { installationStatus, type Activity } from "./installation-status.ts";
import { PullProgress } from "./pull-progress.ts";
import { readReleaseSettings, releaseReference } from "../../../packages/shared/src/release-source.ts";
import { createReleaseRegistry, releaseDockerConfig } from "./release-registry.ts";
import { createReleaseRequests, prepareRelease } from "./releases.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { installWorkspaceFirewall, resolverAddresses } from "./firewall.ts";
import { filesystemFailure } from "./filesystems.ts";
import { initializeResources } from "./resources.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, chown, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { uninstallManagedResources, uninstallPlan, uninstallSocketPath, type UninstallState } from "./uninstall.ts";
import { parseArgs } from "node:util";
import { command, docker, sleep, stopCommands } from "./process.ts";
import { TailscaleHttps, TailscaleCertificateError } from "./tailscale-https.ts";
import { setSupervisorRoutes } from "./tailscale.ts";
import { supervisorFragment, page } from "./ui.ts";
import { readAppTheme } from "./app-theme.ts";

const { values } = parseArgs({
  options: {
    "access-mode": { type: "string", default: "tailscale" },
    "app-image": {
      type: "string",
      default: "ghcr.io/lucasmeijer/agents-in-the-cloud:latest",
    },
  },
  strict: true,
});
let resources: Awaited<ReturnType<typeof initializeResources>>;
const timeout = 120_000;
const stateDir = "/data/supervisor";
await Promise.all(
  [
    stateDir,
    "/data/app",
    "/data/tailscale",
    "/data/erofs-cache",
    "/run/tailscale",
  ].map((path) => mkdir(path, { recursive: true })),
);
await mkdir("/run/agents-in-the-cloud-system", { recursive: true });
await writeFile("/run/agents-in-the-cloud-system/access-v1", "");
// Retain the serialized accessMode field and external access API spelling.
type State = { accessMode?: "localhost" | "tailscale"; localPort?: number; currentImage?: string; previousImage?: string; pendingImage?: string; tailscaleHostname?: string; runningContainers?: string[]; uninstall?: UninstallState };
const persisted: State = (await Bun.file(`${stateDir}/state.json`).exists())
  ? JSON.parse(await readFile(`${stateDir}/state.json`, "utf8"))
  : {};
persisted.accessMode ??= Value.Parse(Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")]), values["access-mode"]);
persisted.tailscaleHostname = Value.Parse(Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" }), persisted.tailscaleHostname ?? "agents-in-the-cloud-system");
const tailscaleHostname = persisted.tailscaleHostname;
if (persisted.pendingImage) Value.Assert(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), persisted.pendingImage);
const tailscaleSelected = () => persisted.accessMode === "tailscale";
async function persist() {
  await writeFile(`${stateDir}/state.next`, JSON.stringify(persisted));
  await rename(`${stateDir}/state.next`, `${stateDir}/state.json`);
}
if (persisted.uninstall?.state === "running") {
  persisted.uninstall = { state: "failed", description: "Uninstall was interrupted. Run --uninstall again to finish removing the installation." };
  await persist();
}
let uninstalling = persisted.uninstall !== undefined;
let activity: Activity = { description: "Starting AgentsInTheCloud services" };
let failure: string | undefined;
let operation: "startup" | "update" = "startup";
let phase = 0;
let candidate = persisted.currentImage ?? values["app-image"]!;
let busy = false;
let activeOperation: Promise<void> = Promise.resolve();
let startup: Promise<void> = Promise.resolve();
let initialized = false;
let healthy = false;
let recoveringHealth = false;
let stopping = false;
let tailnetHost: string | undefined;
let connectionState = tailscaleSelected() ? "Starting" : "Stopped";
let authUrl: string | undefined;
let connectionAttempt: "idle" | "running" | "finished" = "idle";
let connectionFailure: string | undefined;
let networkError: string | undefined;
const tailscaleHttps = new TailscaleHttps();
let httpsAction: { description: string; url?: string } | undefined;
let lastNetworkSuccess = Date.now();
let connectionStateSince = Date.now();
let routeTarget = 3001;
let logProcess: ChildProcess | undefined;
const logs: string[] = [];
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
function connectionProblem() {
  if (!tailscaleSelected()) return;
  if (httpsAction) return;
  if (connectionFailure) return connectionFailure;
  if (networkError && Date.now() - lastNetworkSuccess >= 60_000)
    return `Could not prepare the private connection: ${networkError}`;
  const awaitingUser = connectionState === "NeedsMachineAuth" ||
    (connectionState === "NeedsLogin" && !!authUrl);
  if (connectionState !== "Running" && !awaitingUser && Date.now() - connectionStateSince >= 120_000)
    return "The private connection did not finish starting within 2 minutes.";
}
function fragment() {
  return supervisorFragment({ operation, phase, healthy, recoveringHealth, stopping, failure, candidate,
    connectionMode: persisted.accessMode!, connectionState, connectionProblem: connectionProblem(), connectionAction: tailscaleSelected() ? httpsAction : undefined, authUrl: tailscaleSelected() ? authUrl : undefined, logs });
}
function emit(event = "progress", data = fragment()) {
  for (const subscriber of subscribers)
    subscriber.enqueue(
      encoder.encode(
        `event: ${event}\ndata: ${data.replace(/\n/g, "\ndata: ")}\n\n`,
      ),
    );
}
function accessChanged() {
  emit("access", "changed");
  emit();
}
async function setConnectionMode(mode: "localhost" | "tailscale") {
  persisted.accessMode = mode;
  if (mode === "tailscale" && connectionAttempt !== "running") {
    connectionAttempt = "idle";
    connectionFailure = networkError = undefined;
    connectionStateSince = lastNetworkSuccess = Date.now();
  }
  await persist();
  accessChanged();
}
setInterval(() => emit("ping", ""), 15000);
function log(text: string) {
  text = text.trimEnd();
  console.log(text);
  logs.push(...text.split("\n"));
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  emit();
}
function reportFailure(message: string) {
  failure = message;
  stage("AgentsInTheCloud needs attention");
  log(failure);
}
function stage(text: string, nextPhase = phase) {
  phase = nextPhase;
  activity = { description: text };
  log(text);
}
const children: ChildProcess[] = [];
const intentionallyStopped = new WeakSet<ChildProcess>();
function daemon(args: string[]) {
  const child = spawn(args[0]!, args.slice(1), { stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => {
    log(error.message);
    void shutdown(1);
  });
  child.on("exit", (code, signal) => {
    children.splice(children.indexOf(child), 1);
    if (!stopping && !intentionallyStopped.has(child)) {
      log(`${args[0]} exited (${code ?? signal})`);
      void shutdown(1);
    }
  });
  return child;
}
async function waitFor(
  check: () => Promise<boolean>,
  milliseconds: number,
  description: string,
) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end && !stopping) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function appIsHealthy() {
  try {
    return (
      await fetch("http://127.0.0.1:3000/up", {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    return false;
  }
}
async function existsContainer() {
  return (await docker("ps", "-aq", "--filter", "name=^agents-in-the-cloud$")).length > 0;
}
async function pullImage(reference: string, description: string) {
  const progress = new PullProgress();
  stage(description);
  try {
    await command(["docker", "--config", releaseDockerConfig, "pull", reference], (chunk) => {
      const layers = progress.push(chunk);
      activity = { description: layers ? `${description} · ${layers.completed}/${layers.total} layers ready` : description };
      log(chunk);
    }, 1_800_000);
  } finally {
    activity = { description };
  }
}
async function prepareImage(reference: string, options: { pullApp: boolean; pullDependencies: boolean }): Promise<string> {
  // Resolve the exact local image ID once. No subsequent tag lookup can change the update.
  if (options.pullApp && !(await docker("image", "ls", "-q", reference)))
    await pullImage(reference, "Downloading AgentsInTheCloud");
  const image = JSON.parse(await docker("image", "inspect", reference))[0];
  const preload: unknown = JSON.parse(
    image.Config.Labels?.["eagerly-preload"] ?? "[]",
  );
  if (
    !Value.Check(Type.Array(Type.String({ minLength: 1, pattern: "^(?!-)" })), preload)
  )
    throw new Error("eagerly-preload must be a JSON array of image references");
  for (const ref of preload) {
    if (options.pullDependencies) await pullImage(ref, `Downloading workspace image ${ref}`);
    else await docker("image", "inspect", ref);
  }
  return image.Id;
}
const releaseRegistry = createReleaseRegistry();
async function prepareSelectedRelease(reference: string) {
  return prepareRelease(reference, {
    fetcher: await releaseRegistry.fetcher(),
    pull: reference => pullImage(reference, "Downloading release image"),
    tag: async (pinned, alias) => { await docker("tag", pinned, alias); },
    inspect: reference => docker("image", "inspect", "--format", "{{.Id}}", reference),
  });
}
const releaseRequests = createReleaseRequests({
  settingsPath: "/data/app/update.json", registry: releaseRegistry,
  busy: () => busy || stopping || uninstalling,
  prepare: async reference => {
    if (busy || stopping || uninstalling) throw new Error("An app operation is already running");
    busy = true;
    try { return await prepareSelectedRelease(reference); }
    finally { busy = false; }
  },
});
let routing: Promise<void> = Promise.resolve();
let appliedRoute = "";
function accessOrigin(): string | undefined {
  if (!tailscaleSelected()) return persisted.localPort ? `http://agents-in-the-cloud.localhost:${persisted.localPort}` : undefined;
  if (tailnetHost && appliedRoute === `${tailnetHost}:${routeTarget}`) return `https://${tailnetHost}`;
  return undefined;
}
function configureRoutes(target: number): Promise<void> {
  routeTarget = target;
  // Serialize Serve mutations, always using the most recent desired destination.
  const previous = routing;
  routing = (async () => {
    try {
      await previous;
    } catch {
      /* Previous caller reports failure; this is its retry. */
    }
    while (tailscaleSelected() && tailnetHost && !stopping) {
      const key = `${tailnetHost}:${routeTarget}`;
      if (appliedRoute === key) return;
      const target = routeTarget;
      await setSupervisorRoutes(tailnetHost, target);
      appliedRoute = key;
    }
  })();
  return routing;
}
type Replacement = { image: string; pull: boolean } | { channel: true };
let replacement: Replacement = { image: persisted.pendingImage ?? candidate, pull: !persisted.currentImage && !persisted.pendingImage };
async function replace(request: Replacement) {
  if (busy || stopping || uninstalling)
    throw new Error(
      "An app operation is already running or System is stopping",
    );
  busy = true;
  recoveringHealth = false;
  failure = undefined;
  healthy = false;
  replacement = request;
  phase = 0;
  try {
    await configureRoutes(3001);
    stage("Preparing AgentsInTheCloud");
    const preparedRelease = "channel" in request || (request.pull && /^(ghcr\.io|docker\.io)\//.test(request.image));
    const reference = "channel" in request
      ? (await prepareSelectedRelease(releaseReference(await readReleaseSettings("/data/app/update.json"), "app"))).imageId
      : preparedRelease ? (await prepareSelectedRelease(request.image)).imageId : request.image;
    candidate = reference;
    const exact = await prepareImage(reference, {
      pullApp: !preparedRelease && !("channel" in request) && request.pull,
      pullDependencies: !preparedRelease && !("channel" in request) && request.pull,
    });
    candidate = exact;
    if (stopping) return;
    if (persisted.currentImage && persisted.currentImage !== exact) {
      persisted.previousImage = persisted.currentImage;
      await persist();
    }
    stage("Stopping AgentsInTheCloud", 1);
    logProcess?.kill();
    logProcess = undefined;
    if (await existsContainer()) {
      await docker("stop", "--time", "30", "agents-in-the-cloud");
      await docker("rm", "agents-in-the-cloud");
    }
    if (stopping) return;
    stage("Starting AgentsInTheCloud", 2);
    await docker(
      "run",
      "-d",
      "--init",
      "--name",
      "agents-in-the-cloud",
      "--network",
      "host",
      "--cgroup-parent",
      resources.managementCgroupParent,
      "--cgroupns",
      "host",
      "--mount",
      `type=bind,src=${resources.commandsCgroup},dst=/run/agents-in-the-cloud-system/workload-processes`,
      "--mount",
      `type=bind,src=${resources.buildClientsCgroup},dst=/run/agents-in-the-cloud-system/build-client-processes`,
      "--mount",
      "type=bind,src=/run/agents-in-the-cloud-system/resources.json,dst=/run/agents-in-the-cloud-system/resources.json,readonly",
      "--mount",
      "type=bind,src=/run/agents-in-the-cloud-host,dst=/run/agents-in-the-cloud-host,readonly",
      "--mount",
      "type=bind,src=/run/agents-in-the-cloud-system/access-v1,dst=/run/agents-in-the-cloud-system/access-v1,readonly",
      "--label",
      "agents-in-the-cloud.role=app",
      "--mount",
      "type=bind,src=/data/app,dst=/data/app",
      "--mount",
      "type=bind,src=/data/erofs-cache,dst=/data/erofs-cache",
      "--mount",
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
      "--mount",
      "type=bind,src=/run/containerd/containerd.sock,dst=/run/containerd/containerd.sock",
      "--mount",
      "type=bind,src=/var/run/tailscale,dst=/var/run/tailscale",
      exact,
    );
    logProcess = spawn(
      "docker",
      ["logs", "--follow", "--since", "1m", "agents-in-the-cloud"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const output of [logProcess.stdout!, logProcess.stderr!])
      output.on("data", (data) => log(data.toString().trimEnd()));
    stage("Checking AgentsInTheCloud is healthy", 3);
    await waitFor(appIsHealthy, timeout, "AgentsInTheCloud health");
    persisted.currentImage = exact;
    if (persisted.pendingImage === exact) delete persisted.pendingImage;
    await persist();
    stage("Opening AgentsInTheCloud", 4);
    await openApp();
  } catch (error) {
    reportFailure(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    emit();
  }
}
async function openApp() {
  await configureRoutes(3000);
  if (stopping) return;
  healthy = true;
  recoveringHealth = false;
  failure = undefined;
  stage("AgentsInTheCloud is ready", 4);
  emit("ready", "ready");
}

// Reserve the operation while probing/routing so replacement and shutdown cannot
// race a late successful probe into reopening the old app.
async function recheckHealth() {
  busy = true;
  try {
    const ready = await appIsHealthy();
    if (stopping) return;
    if (!ready) {
      if (healthy) {
        healthy = false;
        recoveringHealth = true;
        failure = "AgentsInTheCloud stopped responding to health checks";
        stage("AgentsInTheCloud needs attention", 3);
      }
      await configureRoutes(3001);
    } else if (recoveringHealth) {
      await openApp();
    }
  } catch (error) {
    log(String(error));
  } finally {
    busy = false;
  }
}
function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return (
    !origin ||
    (persisted.localPort && origin === `http://agents-in-the-cloud.localhost:${persisted.localPort}`) ||
    origin === new URL(request.url).origin ||
    (tailnetHost &&
      (origin === `https://${tailnetHost}` ||
        origin === `https://${tailnetHost}:8443`))
  );
}
const localIngress = startLocalIngress(() => routeTarget);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3001,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/release/")) {
      if (request.method !== "GET" && !allowedOrigin(request)) return new Response("Forbidden", { status: 403 });
      const response = await releaseRequests(request);
      if (response) return response;
    }
    if (url.pathname === "/access") {
      if (request.method === "POST") {
        if (!allowedOrigin(request)) return new Response("Forbidden", { status: 403 });
        const body: unknown = await request.json().catch(() => null);
        if (!Value.Check(Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")])), localPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })) }), body)) return new Response("Invalid access setting", { status: 400 });
        if (body.localPort) persisted.localPort = body.localPort;
        if (body.mode) await setConnectionMode(body.mode);
        else { await persist(); accessChanged(); }
      }
      return Response.json({ mode: persisted.accessMode, localPort: persisted.localPort, connectionState, authUrl, origin: accessOrigin(), error: connectionFailure ?? networkError });
    }
    if (url.pathname === "/status") {
      // Check again at the handoff: startup health alone can become stale.
      const appResponding = healthy && await appIsHealthy();
      return Response.json({
        ...installationStatus({
          activity: healthy && !appResponding ? { description: "Checking AgentsInTheCloud is healthy" } : activity,
          failure: failure ?? connectionProblem(),
          stopping, busy, appResponding, hostname: tailnetHost, appliedRoute,
          connectionState, authUrl, connectionAction: httpsAction, logs,
          localOrigin: persisted.localPort ? `http://agents-in-the-cloud.localhost:${persisted.localPort}` : undefined,
          localMode: !tailscaleSelected(),
        }),
        failure,
        healthy,
        busy,
        candidate,
        currentImage: persisted.currentImage,
        previousImage: persisted.previousImage,
        uninstall: persisted.uninstall,
        tailnetHost,
        connectionState,
        localOrigin: persisted.localPort ? `http://agents-in-the-cloud.localhost:${persisted.localPort}` : undefined,
        logs,
      });
    }
    if (url.pathname === "/events") {
      const origin = request.headers.get("origin");
      if (origin && !allowedOrigin(request))
        return new Response("Forbidden", { status: 403 });
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          subscribers.add(c);
          c.enqueue(
            encoder.encode(
              `event: progress\ndata: ${fragment().replace(/\n/g, "\ndata: ")}\n\n`,
            ),
          );
          if (healthy)
            c.enqueue(encoder.encode("event: ready\ndata: ready\n\n"));
        },
        cancel() {
          subscribers.delete(controller);
        },
      });
      const headers = new Headers({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      if (origin) {
        headers.set("access-control-allow-origin", origin);
        headers.set("vary", "Origin");
      }
      return new Response(stream, { headers });
    }
    if (request.method === "POST") {
      if (uninstalling) return new Response("Installation is being uninstalled", { status: 409 });
      if (!allowedOrigin(request))
        return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/local") {
        await setConnectionMode("localhost");
        return Response.redirect(url.origin, 303);
      }
      if (url.pathname === "/connect") {
        if (stopping) return new Response("System is stopping", { status: 503 });
        await setConnectionMode("tailscale");
        return request.headers.get("accept")?.includes("text/html") ? Response.redirect(url.origin, 303) : new Response(null, { status: 202 });
      }
      if (!initialized || stopping)
        return new Response("System is starting or stopping", { status: 503 });
      if (busy)
        return new Response("An operation is already running", { status: 409 });
      if (url.pathname === "/recheck") {
        if (!recoveringHealth) return new Response("No health recovery is pending", { status: 409 });
        activeOperation = recheckHealth();
        await activeOperation;
        return Response.redirect(request.headers.get("origin") ?? url.origin, 303);
      }
      if (url.pathname === "/retry") {
        activeOperation = replace(replacement);
        return Response.redirect(
          request.headers.get("origin") ?? url.origin,
          303,
        );
      }
      if (url.pathname === "/rollback") {
        if (!persisted.previousImage) return Response.json({ error: "No previous app image is recorded" }, { status: 409 });
        busy = true;
        try { await prepareImage(persisted.previousImage, { pullApp: false, pullDependencies: false }); }
        finally { busy = false; }
        operation = "update";
        activeOperation = replace({ image: persisted.previousImage, pull: false });
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (url.pathname === "/update-channel") {
        operation = "update";
        // replace reserves busy and clears stale health/failure synchronously,
        // before acknowledging. No app request or healthy startup is required.
        activeOperation = replace({ channel: true });
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (url.pathname === "/update") {
        const body: unknown = await request.json().catch(() => null);
        if (
          !Value.Check(Type.Object({ image: Type.String({ minLength: 1, pattern: "^(?!-)[^\\s]+$" }) }), body)
        )
          return new Response("Expected image reference", { status: 400 });
        // Reserve the operation across asynchronous validation; reject invalid requests
        // before interrupting the healthy app.
        if (busy || stopping)
          return new Response(
            "An operation is already running or System is stopping",
            { status: 409 },
          );
        busy = true;
        let exact: string;
        try {
          exact = await prepareImage(body.image, { pullApp: false, pullDependencies: false });
        } catch (error) {
          busy = false;
          return new Response(String(error), { status: 400 });
        }
        if (stopping) {
          busy = false;
          return new Response("System is stopping", { status: 503 });
        }
        const previouslyHealthy = healthy;
        healthy = false;
        try {
          await configureRoutes(3001);
        } catch (error) {
          healthy = previouslyHealthy;
          busy = false;
          return new Response(String(error), { status: 502 });
        }
        operation = "update";
        stage("Preparing AgentsInTheCloud", 0);
        // Route first, acknowledge, then give the app time to relay that acknowledgement.
        // Replacement remains supervisor-owned if the requesting browser disconnects.
        activeOperation = (async () => {
          await Bun.sleep(1000);
          busy = false;
          if (!stopping) await replace({ image: exact, pull: false });
        })();
        return Response.json({ accepted: true }, { status: 202 });
      }
    }
    if (url.pathname === "/client.js" || url.pathname === "/design-system.css")
      return new Response(
        Bun.file(new URL(`.${url.pathname}`, import.meta.url)),
        { headers: { "access-control-allow-origin": "*" } },
      );
    // Tailscale preserves the app path when routing this origin to the supervisor.
    // Open workspace tabs must reach progress rather than a missing app route.
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Not found", { status: 404 });
    if (url.pathname !== "/")
      return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
    const diagnostic = url.port === "8443" || url.hostname === "system.agents-in-the-cloud.localhost";
    const local = url.hostname.endsWith(".localhost");
    const events = local ? `${url.protocol}//system.agents-in-the-cloud.localhost:${url.port}/events` : tailnetHost
      ? `https://${tailnetHost}:8443/events`
      : "/events";
    return new Response(
      page(
        "AgentsInTheCloud System",
        `<section data-controller="progress" data-progress-events-value="${escapeHtml(events)}" data-progress-return-value="${!diagnostic && (local || !!tailnetHost)}"><div data-progress-content>${fragment()}</div></section>`,
        local ? "" : tailnetHost ? `https://${tailnetHost}:8443` : "",
        await readAppTheme(),
      ),
      { headers: { "content-type": "text/html" } },
    );
  },
});
// Only root inside System (the host installer via docker exec) can request deletion.
// Never expose this operation through the public local/Tailscale supervisor routes.
await rm(uninstallSocketPath, { force: true });
const previousUmask = process.umask(0o077);
const uninstallControl = Bun.serve({
  unix: uninstallSocketPath,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/uninstall") return new Response("Not found", { status: 404 });
    if (!initialized || stopping || busy) return new Response("System is starting or busy", { status: 503 });
    if (request.method === "GET") {
      try { return Response.json(await uninstallPlan(docker)); }
      catch (error) { log(String(error)); return new Response("Could not read workspace inventory. Nothing has been deleted.", { status: 500 }); }
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body: unknown = await request.json().catch(() => null);
    if (!Value.Check(Type.Object({ token: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }), body))
      return new Response("Expected the reviewed uninstall inventory token", { status: 400 });
    if (persisted.uninstall?.state === "complete") return new Response(null, { status: 202 });
    // Reserve before yielding, so health recovery and updates cannot restart the app.
    uninstalling = true;
    busy = true;
    healthy = false;
    recoveringHealth = false;
    activeOperation = (async () => {
      const progress = async (description: string) => {
        persisted.uninstall = { state: "running", description };
        await persist();
        stage(description);
      };
      try {
        await progress("Preparing to uninstall AgentsInTheCloud");
        await configureRoutes(3001);
        logProcess?.kill();
        logProcess = undefined;
        await uninstallManagedResources({ token: body.token, docker, progress });
        persisted.runningContainers = [];
        persisted.uninstall = { state: "complete", description: "Managed resources deleted. Ready to remove System and its installation volume." };
        await persist();
        stage(persisted.uninstall.description);
      } catch (error) {
        const description = error instanceof Error ? error.message : String(error);
        persisted.uninstall = { state: "failed", description };
        await persist();
        log(description);
      } finally {
        busy = false;
      }
    })();
    return new Response(null, { status: 202 });
  },
});
await chmod(uninstallSocketPath, 0o600);
process.umask(previousUmask);

async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  healthy = false;
  stage("Stopping AgentsInTheCloud services");
  stopCommands();
  await startup;
  await activeOperation;
  await routing.catch((error) => log(String(error)));
  try {
    if (!uninstalling) {
      const running = (await docker("ps", "-q", "--filter", "name=^agents-in-the-cloud$"))
        .split("\n")
        .filter(Boolean);
      const all = (await docker("ps", "-q")).split("\n").filter(Boolean);
      persisted.runningContainers = [
        ...new Set([
          ...(persisted.runningContainers ?? []),
          ...all.filter((id) => !running.includes(id)),
        ]),
      ];
      await persist();
      if (all.length) await docker("stop", "--time", "20", ...all);
    }
  } catch (error) {
    log(String(error));
    code = 1;
  }
  logProcess?.kill();
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(15000),
    ]);
  }
  localIngress.stop(true);
  uninstallControl.stop(true);
  server.stop(true);
  process.exit(code);
}
process.on("SIGTERM", () => {
  void shutdown(0);
});
process.on("SIGINT", () => {
  void shutdown(0);
});
async function initialize() {
  stage("Checking Docker host requirements");
  failure = filesystemFailure(await readFile("/proc/filesystems", "utf8"));
  if (failure) {
    log(failure);
    return;
  }
  resources = await initializeResources();
  await startHostService({ root: dirname(dirname(resources.commandsCgroup)), effectiveMemory: resources.effectiveMemory });
  await chown(hostSocketPath, 1000, 1000);
  await installWorkspaceFirewall(resources.buildClientsCgroupParent, resolverAddresses(await readFile("/etc/resolv.conf", "utf8")));
  // Privileged containers only copy device nodes the host /dev already has; some
  // VMs lack loop-control until first use. Opening it autoloads the loop driver.
  if (!existsSync("/dev/loop-control")) await command(["mknod", "-m", "0660", "/dev/loop-control", "c", "10", "237"]);
  daemon(["containerd", "--config", "/etc/containerd/config.toml"]);
  await waitFor(
    async () => {
      try {
        await command(["ctr", "version"]);
        return true;
      } catch {
        return false;
      }
    },
    30000,
    "containerd",
  );
  daemon(["dockerd", "--config-file", "/run/agents-in-the-cloud-system/daemon.json"]);
  await waitFor(
    async () => {
      try {
        await docker("info");
        return true;
      } catch {
        return false;
      }
    },
    60000,
    "Docker",
  );
  if (uninstalling) { initialized = true; return; }
  for (const id of persisted.runningContainers ?? []) await docker("start", id);
  persisted.runningContainers = [];
  await persist();
  // Tailscale login may happen after app boot. Its network state is independent.
  void (async () => {
    connectionStateSince = lastNetworkSuccess = Date.now();
    let lastAccess = "";
    let tailscaleProcess: ChildProcess | undefined;
    let login: AbortController | undefined;
    function notifyAccessChanges() {
      const nextAccess = JSON.stringify([persisted.accessMode, connectionState, authUrl, connectionFailure, networkError, httpsAction, accessOrigin()]);
      if (nextAccess !== lastAccess) { lastAccess = nextAccess; accessChanged(); }
    }
    while (!stopping) {
      if (!tailscaleSelected()) {
        if (tailscaleProcess) {
          login?.abort();
          login = undefined;
          intentionallyStopped.add(tailscaleProcess);
          const child = tailscaleProcess;
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          tailscaleProcess.kill("SIGTERM");
          await exited;
          tailscaleProcess = undefined;
        }
        connectionState = "Stopped";
        authUrl = tailnetHost = connectionFailure = networkError = undefined;
        httpsAction = undefined;
        appliedRoute = "";
        connectionAttempt = "idle";
        tailscaleHttps.reset();
        notifyAccessChanges();
        await sleep(3000);
        continue;
      }
      if (!tailscaleProcess) {
        tailscaleProcess = daemon([
          "tailscaled",
          "--state=/data/tailscale/tailscaled.state",
          "--socket=/var/run/tailscale/tailscaled.sock",
        ]);
        connectionStateSince = lastNetworkSuccess = Date.now();
      }
      try {
        const status = JSON.parse(
          await command(["tailscale", "status", "--json"], undefined, 5000),
        );
        if (!tailscaleSelected()) continue;
        if (status.BackendState !== connectionState) connectionStateSince = Date.now();
        connectionState = status.BackendState;
        authUrl = status.AuthURL || undefined;
        if (connectionAttempt === "idle" &&
            (connectionState === "NeedsLogin" || connectionState === "Stopped")) {
          connectionAttempt = "running";
          // The browser sign-in is the user's consent; generating its URL does
          // not connect an account. System owns this command and its deadline.
          const attempt = new AbortController();
          login = attempt;
          void command(["tailscale", "up", "--timeout=10m", "--hostname", tailscaleHostname], log, 610_000, attempt.signal)
            .catch((error) => {
              if (!tailscaleSelected() || attempt.signal.aborted) return;
              connectionFailure = `Could not connect AgentsInTheCloud: ${String(error)}`;
              log(connectionFailure);
            }).finally(() => { if (tailscaleSelected() && !attempt.signal.aborted) connectionAttempt = "finished"; });
        }
        if (connectionState === "Running" && status.Self?.HostName !== persisted.tailscaleHostname) await command(["tailscale", "set", "--hostname", persisted.tailscaleHostname!], undefined, 5000);
        const host =
          status.BackendState === "Running"
            ? status.Self.DNSName.replace(/\.$/, "")
            : undefined;
        if (host) {
          const changed = host !== tailnetHost;
          if (changed) {
            tailnetHost = undefined;
            appliedRoute = "";
            httpsAction = { description: "Preparing Tailscale HTTPS…" };
            accessChanged();
          }
          await tailscaleHttps.prepare(host, Value.Parse(Type.Optional(Type.Union([Type.Null(), Type.Array(Type.String())])), status.CertDomains));
          if (!tailscaleSelected()) continue;
          tailnetHost = host;
          await configureRoutes(routeTarget);
          if (changed) log(`Tailscale ready: https://${host}`);
        } else {
          tailnetHost = undefined;
          appliedRoute = "";
          tailscaleHttps.reset();
        }
        lastNetworkSuccess = Date.now();
        networkError = undefined;
        httpsAction = undefined;
        if (host) connectionFailure = undefined;
      } catch (error) {
        if (!tailscaleSelected()) continue;
        networkError = error instanceof Error ? error.message : String(error);
        if (error instanceof TailscaleHttpsDisabledError || error instanceof TailscaleCertificateError) {
          tailnetHost = undefined;
          appliedRoute = "";
          httpsAction = { description: networkError, url: tailscaleHttpsSettingsUrl };
        } else {
          httpsAction = undefined;
        }
        log(`Tailscale: ${networkError}`);
      }
      notifyAccessChanges();
      await sleep(3000);
    }
  })();
  if (stopping) return;
  if (persisted.accessMode === "localhost") await waitFor(async () => !!persisted.localPort, 60000, "installer to register the local port");
  initialized = true;
  activeOperation = replace(replacement);
  void (async () => {
    while (!stopping) {
      await sleep(3000);
      if ((!healthy && !recoveringHealth) || busy || stopping || uninstalling) continue;
      activeOperation = recheckHealth();
      await activeOperation;
    }
  })();
}
startup = initialize().catch((error) => {
  if (!stopping) {
    reportFailure(error instanceof Error ? error.message : String(error));
  }
});
