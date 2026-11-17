#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { authenticateRegistry, commandRunner, ensureBuilders, inspectImage, inspectPlatform, platforms, type Run } from "../../scripts/release-support.ts";
import { systemVersion, systemVersionLabel } from "../../packages/shared/src/system-version.ts";
import { systemRepository as image } from "../../packages/shared/src/publishing.ts";

const root = resolve(import.meta.dir, "../..");

export async function publishSystem(run: Run, directory: string, check = false, stable = false) {
  if (!check && (await run(["git", "status", "--porcelain"])).stdout.trim())
    throw new Error("Commit changes before publishing System.");

  // Same SSH destination, architecture checks, integrated Docker builders, and
  // native execution probes as the normal release. There is no emulation path.
  const builders = await ensureBuilders(run, directory);
  if (check) return;

  const revision = (await run(["git", "rev-parse", "HEAD"])).stdout.trim();
  const ref = `${image}:sha-${revision}`;
  await authenticateRegistry(run);
  await run(["bun", "install", "--cwd", "images/system", "--frozen-lockfile"], { stream: true });
  await run(["bun", "images/system/build.ts"], { stream: true });

  const slices: string[] = [];
  for (const platform of platforms) {
    const context = platform === builders.nativePlatform ? builders.local : builders.remote;
    const slice = `${ref}-${platform.split("/")[1]}`;
    await run(["docker", "--context", context, "buildx", "build", "--platform", platform,
      "--provenance=false", "--push", "--progress", "plain", "--tag", slice,
      "--label", `org.opencontainers.image.revision=${revision}`,
      "--label", `${systemVersionLabel}=${systemVersion}`,
      "--file", "images/system/Dockerfile", "images/system"], { stream: true });
    const manifest = JSON.parse((await run(["docker", "buildx", "imagetools", "inspect", slice, "--format", "{{json .Manifest}}"])).stdout);
    if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) throw new Error(`Registry returned no digest for ${slice}`);
    const pinned = `${image}@${manifest.digest}`;
    await inspectPlatform(run, pinned, platform, revision);
    slices.push(pinned);
  }
  await run(["docker", "buildx", "imagetools", "create", "--tag", ref, ...slices], { stream: true });
  const combined = (await inspectImage(run, ref))!;
  for (const slice of slices) {
    if (!combined.manifests.some(entry => `${image}@${entry.digest}` === slice))
      throw new Error(`${ref}: combined manifest does not contain verified slice ${slice}`);
  }
  console.log(`Published ${ref}@${combined.digest}`);
  for (const channel of stable ? ["latest", "stable"] : ["latest"]) {
    await run(["docker", "buildx", "imagetools", "create", "--tag", `${image}:${channel}`, `${image}@${combined.digest}`], { stream: true });
    if ((await inspectImage(run, `${image}:${channel}`))!.digest !== combined.digest)
      throw new Error(`${image}:${channel}: registry digest differs from ${ref}`);
    console.log(`Promoted ${image}:${channel} to ${combined.digest}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--stable", "--help", "-h"].includes(arg))) {
    console.error("Usage: images/system/publish.sh [--stable] [--check]");
    process.exitCode = 1;
  } else if (args.includes("--help") || args.includes("-h")) {
    console.log("Publish System's commit image using two native Docker daemons and move latest to it.\nRequires ATELIER_RELEASE_HELPER=[user@]hostname and GH_PACKAGE_TOKEN.\n--stable also moves stable, for installations on the Stable update channel.\n--check validates both native builders without publishing.");
  } else {
    const directory = mkdtempSync(join(tmpdir(), "agents-in-the-cloud-system-publish-"));
    const commands = commandRunner(root, text => process.stdout.write(text));
    let interrupted = false;
    const stop = () => { interrupted = true; commands.stop(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const run: Run = (args, options) => {
      if (interrupted) throw new Error("System publication interrupted");
      return commands.run(args, options);
    };
    try {
      await publishSystem(run, directory, args.includes("--check"), args.includes("--stable"));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
