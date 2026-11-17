#!/usr/bin/env bun
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { authenticateRegistry, commandRunner, ensureBuilders, inspectImage, inspectPlatform, platformLabels, platforms, type Run } from "./release-support.ts";
import { prepareReleaseNotes, publishReleaseNotes, readReleaseNotes } from "./release-notes.ts";
import { parseSystemVersion, requiredSystemVersionLabel, systemVersionLabel } from "../packages/shared/src/system-version.ts";
import { acquireReleaseLock } from "./release-lock.ts";
import { appRepository as image, systemRepository as systemImage } from "../packages/shared/src/publishing.ts";

const root = resolve(import.meta.dir, "..");
export const usage = `Release AgentsInTheCloud from the current origin/main commit.

  bun run release             Publish latest
  bun run release --stable --notes release_notes/YYYY-MM-DD-description.md
                              Publish latest and stable with handwritten notes
  bun run release --prepare   Build and verify without updating either channel
  bun run release --stable --revision <full-sha> --notes release_notes/YYYY-MM-DD-description.md
                              Publish a prepared revision with approved notes from origin/main
  bun run release --check     Check Git, local/SSH Docker builders and both architectures; publish nothing

--check may be combined with --stable. Working files are never released or reset.
Requires ATELIER_RELEASE_HELPER=[user@]hostname with noninteractive SSH and Docker access.
Uses the existing GH_PACKAGE_TOKEN for images and gh CLI authentication for GitHub Releases.
Logs/status live under Git's
common directory in agents-in-the-cloud-releases/<run-id>/. See docs/releases.md.
`;

interface ReleaseOptions { stable: boolean; check: boolean; help: boolean; notes?: string; revision?: string; prepare: boolean; }

export function parseReleaseArgs(args: string[]) {
  let notes: string | undefined;
  let revision: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--notes") {
      if (notes !== undefined) throw new Error("Supply --notes only once");
      notes = args[++index];
      if (!notes || notes.startsWith("--")) throw new Error("--notes needs a file path");
    } else if (arg === "--revision") {
      if (revision !== undefined) throw new Error("Supply --revision only once");
      revision = args[++index];
      if (!revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("--revision needs a full Git commit SHA");
    } else if (!["--prepare", "--stable", "--check", "--help", "-h"].includes(arg)) throw new Error(`Unknown release option: ${arg}`);
  }
  const options: ReleaseOptions = { prepare: args.includes("--prepare"), stable: args.includes("--stable"), check: args.includes("--check"), help: args.includes("--help") || args.includes("-h") };
  if (revision !== undefined) options.revision = revision;
  if (notes !== undefined) options.notes = notes;
  if (options.prepare && (options.stable || options.check || notes)) throw new Error("--prepare builds only; do not combine it with --stable, --check or --notes");
  if (!options.help && options.stable && !options.check && !notes) throw new Error("Stable releases require --notes release_notes/YYYY-MM-DD-description.md");
  if (notes && !options.stable) throw new Error("--notes is only used with --stable");
  return options;
}

type ChannelState = "pending" | "promoting" | "published" | "failed";
export interface ReleaseStatus {
  state: "running" | "prepared" | "checked" | "published" | "failed";
  phase: string;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  check: boolean;
  sourceRevision?: string;
  commit?: string;
  builder?: string;
  digest?: string;
  channels: Partial<Record<"latest" | "stable", ChannelState>>;
  error?: string;
  releaseNotes?: { id: string; path: string; state: "pending" | "reserved" | "published" };
}
const preloadSchema = Type.Array(Type.String({ pattern: "@sha256:[a-f0-9]{64}$" }), { minItems: 1 });

export async function verifyRevision(run: Run, ref: string, commit: string): Promise<string> {
  const manifest = (await inspectImage(run, ref))!;
  const dependencies = new Set<string>();
  for (const platform of platforms) {
    const entry = manifest.manifests.find((entry) => `${entry.platform.os}/${entry.platform.architecture}` === platform)!;
    const config = await inspectPlatform(run, `${image}@${entry.digest}`, platform, commit);
    const preload: unknown = JSON.parse(config.config.Labels["eagerly-preload"] ?? "[]");
    if (!Value.Check(preloadSchema, preload)) {
      throw new Error(`${ref}: release requires digest-pinned workspace dependencies`);
    }
    for (const dependency of preload) dependencies.add(dependency);
  }
  for (const dependency of dependencies) await inspectImage(run, dependency);
  return manifest.digest;
}

export async function assertChannelSystemsSupportApp(run: Run, appDigest: string, channels: readonly ("latest" | "stable")[]): Promise<void> {
  const app = (await inspectImage(run, `${image}@${appDigest}`))!;
  const required = Math.max(...(await platformLabels(run, image, app)).map((labels) => parseSystemVersion(labels[requiredSystemVersionLabel])));
  for (const channel of channels) {
    const system = await inspectImage(run, `${systemImage}:${channel}`, true);
    const publish = `images/system/publish.sh${channel === "stable" ? " --stable" : ""}`;
    if (!system) throw new Error(`${systemImage}:${channel} isn't published, but ${channel} installations need it. Publish System first: ${publish}`);
    const version = Math.min(...(await platformLabels(run, systemImage, system)).map((labels) => parseSystemVersion(labels[systemVersionLabel])));
    if (version < required) throw new Error(`This app needs System version ${required}, but ${systemImage}:${channel} is version ${version}. Publish System first: ${publish}`);
  }
}

export async function promoteChannels(run: Run, status: ReleaseStatus, save: () => void): Promise<void> {
  for (const channel of ["latest", "stable"] as const) {
    if (status.channels[channel] === undefined) continue;
    status.phase = `Promote ${channel}`;
    status.channels[channel] = "promoting";
    save();
    try {
      await run(["docker", "buildx", "imagetools", "create", "--tag", `${image}:${channel}`, `${image}@${status.digest}`], { stream: true });
      const published = (await inspectImage(run, `${image}:${channel}`))!;
      if (published.digest !== status.digest) throw new Error(`${channel}: registry digest differs from release digest`);
      status.channels[channel] = "published";
      save();
    } catch (error) {
      status.channels[channel] = "failed";
      save();
      throw error;
    }
  }
}

export async function release(options: ReturnType<typeof parseReleaseArgs>, run: Run, status: ReleaseStatus, save: () => void, directory: string): Promise<void> {
  const phase = (text: string) => { status.phase = text; save(); };
  phase("Resolve origin/main");
  await run(["git", "fetch", "origin", "refs/heads/main"]);
  const sourceRevision = (await run(["git", "rev-parse", "FETCH_HEAD^{commit}"])).stdout.trim();
  status.sourceRevision = sourceRevision;
  status.commit = options.revision ?? sourceRevision;
  if (options.revision && options.revision !== sourceRevision) {
    await run(["git", "merge-base", "--is-ancestor", options.revision, sourceRevision]);
    const changes = (await run(["git", "diff", "--name-only", options.revision, sourceRevision])).stdout.trim().split("\n").filter(Boolean);
    if (changes.some(path => !path.startsWith("release_notes/"))) throw new Error("origin/main has code changes after the pinned revision. Prepare the new code and review its release notes before publishing.");
  }
  save();
  const notes = options.notes ? await readReleaseNotes(run, sourceRevision, options.notes) : undefined;
  if (notes) {
    status.releaseNotes = { id: notes.id, path: notes.path, state: "pending" };
    save();
    if (!options.check) {
      phase("Reserve stable release notes on GitHub");
      await prepareReleaseNotes(run, notes, status.commit);
      status.releaseNotes.state = "reserved";
      save();
    }
  }
  phase("Check local and SSH native builders");
  const builders = await ensureBuilders(run, directory);
  status.builder = `${builders.local} + ${builders.remote}`;
  save();
  if (options.check) {
    status.state = "checked";
    phase("Check complete — nothing published");
    return;
  }

  phase("Authenticate registry");
  await authenticateRegistry(run);
  const ref = `${image}:sha-${status.commit}`;
  phase("Look for an existing commit image");
  if (!await inspectImage(run, ref, true)) {
    const checkout = join(directory, "source");
    phase("Check out exact release commit");
    await run(["git", "worktree", "add", "--detach", checkout, status.commit]);
    try {
      phase("Build and upload commit images (no channel updates)");
      await run(["bun", join(root, "scripts/build-agents-in-the-cloud-image.ts"), "--push", "--no-latest", "--tag", `sha-${status.commit}`, "--builder", builders.local, "--helper-context", builders.remote, "--native-platform", builders.nativePlatform, "--platform", platforms.join(","), "--progress", "plain"], { cwd: checkout, stream: true });
    } finally {
      await run(["git", "worktree", "remove", "--force", checkout]);
    }
  }
  phase("Verify both architectures and revision labels");
  status.digest = await verifyRevision(run, ref, status.commit);
  save();
  if (options.prepare) {
    status.state = "prepared";
    phase(`Prepared ${status.commit} — ${status.digest}. No channels or release notes published.`);
    return;
  }
  phase("Confirm main still contains this commit");
  await run(["git", "fetch", "origin", "refs/heads/main"]);
  if ((await run(["git", "merge-base", "--is-ancestor", status.commit, "FETCH_HEAD"], { allowFailure: true })).code !== 0)
    throw new Error(`origin/main no longer contains ${status.commit}; its history was rewritten during this release. Commit image is uploaded; inspect main before retrying.`);
  phase("Check each channel's System supports this app");
  await assertChannelSystemsSupportApp(run, status.digest, options.stable ? ["latest", "stable"] : ["latest"]);
  await promoteChannels(run, status, save);
  if (notes) {
    phase("Publish stable release notes on GitHub");
    await publishReleaseNotes(run, notes, status.commit, status.digest);
    status.releaseNotes!.state = "published";
    save();
  }
  status.state = "published";
  phase(`Published ${Object.keys(status.channels).join(" + ")} — ${status.digest}`);
}

async function main(options: ReturnType<typeof parseReleaseArgs>, common: string): Promise<void> {
  const directory = join(common, "agents-in-the-cloud-releases", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "release.log");
  const statusPath = join(directory, "status.json");
  const started = Date.now();
  const status: ReleaseStatus = {
    state: "running", phase: "Starting", startedAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(), elapsedSeconds: 0,
    check: options.check, channels: options.prepare ? {} : options.stable ? { latest: "pending", stable: "pending" } : { latest: "pending" },
  };
  const output = (text: string) => { process.stdout.write(text); appendFileSync(logPath, text); };
  let lastPhase = "";
  const save = () => {
    status.updatedAt = new Date().toISOString();
    status.elapsedSeconds = Math.floor((Date.now() - started) / 1000);
    writeFileSync(`${statusPath}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
    renameSync(`${statusPath}.tmp`, statusPath);
    if (status.phase !== lastPhase) {
      output(`\n\x1b[36m[${status.elapsedSeconds}s] ${status.phase}\x1b[0m\n`);
      lastPhase = status.phase;
    }
  };
  output(`AgentsInTheCloud release${options.check ? " CHECK (no publishing)" : ""}: ${Object.keys(status.channels).join(" + ")}\nLog: ${logPath}\nStatus: ${statusPath}\n`);
  writeFileSync(join(common, "agents-in-the-cloud-releases", "last-run.txt"), `${directory}\n`);
  save();
  const heartbeat = setInterval(save, 5000);
  const commands = commandRunner(root, output);
  let interrupted = false;
  const interrupt = () => { interrupted = true; commands.stop(); };
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  const run: Run = async (args, command = {}) => {
    if (interrupted && !(args[0] === "git" && args[1] === "worktree" && args[2] === "remove")) throw new Error("Release interrupted");
    return commands.run(args, command);
  };
  try {
    await release(options, run, status, save, directory);
    if (interrupted) throw new Error("Release interrupted");
  } catch (error) {
    status.state = "failed";
    status.error = error instanceof Error ? error.message : String(error);
    output(`\nFAILED: ${status.error}\n`);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    save();
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
    output(`\n${JSON.stringify(status, null, 2)}\n`);
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const worker = args[0] === "--release-worker";
    const options = parseReleaseArgs(worker ? args.slice(1) : args);
    if (options.help) {
      console.log(usage);
    } else {
      const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
      const common = git.stdout.toString().trim();
      if (worker) {
        const unlock = acquireReleaseLock(join(common, "agents-in-the-cloud-release.lock"));
        if (!unlock) {
          process.exitCode = 75;
        } else {
          try {
            await main(options, common);
          } finally {
            unlock();
          }
        }
      } else {
        const child = Bun.spawn([process.execPath, import.meta.path, "--release-worker", ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true });
        const stop = () => { process.kill(-child.pid, "SIGTERM"); };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        const code = await child.exited;
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        if (code === 75) console.error("Another release holds this repository's lock. Wait for it to finish.");
        else if (code !== 0) console.error("Release failed. See the log above.");
        process.exitCode = code;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
