import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReleaseSettings, releaseReference, selectedReleaseChannel } from "../packages/shared/src/release-source.ts";

const installer = await Bun.file(new URL("./install.sh", import.meta.url)).text();
const helper = installer.split("<<'INSTALLER_CONFIG_JS'\n")[1]!.split("INSTALLER_CONFIG_JS\n")[0]!;
const pinned = `sha256:${"a".repeat(64)}`;
const previous = `sha256:${"b".repeat(64)}`;
async function fixture(action: (directory: string, run: (operation: string, ...args: string[]) => { status: number; stdout: string; stderr: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "installer-config-"));
  await mkdir(join(directory, "app")); await mkdir(join(directory, "supervisor"));
  const script = helper.replaceAll("/data/", `${directory}/`);
  const run = (operation: string, ...args: string[]) => {
    const result = Bun.spawnSync(["bun", "-e", script, operation, ...args], { stdin: "ignore" });
    return { status: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
  };
  try { await action(directory, run); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("setup derives matching fork images and persists source, hostname and immutable app", () => fixture(async (directory, run) => {
  const args = ["ghcr.io/example/app", "", "", "cloud-home", pinned, previous, "", pinned];
  expect(run("plan", ...args).stdout.split("\n")).toEqual(["ghcr.io/example/app-system:latest", "ghcr.io/example/app:latest", "cloud-home"]);
  expect(run("apply", ...args).status).toBe(0);
  const settings = await readReleaseSettings(join(directory, "app/update.json"));
  expect(selectedReleaseChannel(settings)).toBe("custom");
  expect(releaseReference(settings, "system")).toBe("ghcr.io/example/app-system:latest");
  const state = JSON.parse(await readFile(join(directory, "supervisor/state.json"), "utf8"));
  expect(state.tailscaleHostname).toBe("cloud-home"); expect(state.pendingImage).toBe(previous);
  expect((await stat(join(directory, "app/update.json"))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(directory, "supervisor/installer.json"), "utf8")).previousSystemImage).toBe(pinned);
}));

test("updates retain saved source, pins and hostname, while explicit upstream selection is honoured", () => fixture(async (directory, run) => {
  await writeFile(join(directory, "app/update.json"), JSON.stringify({ releaseMode: "custom", releaseChannel: "stable", releaseSource: { appRepository: "docker.io/example/app", systemRepository: "ghcr.io/example/system", systemVersion: pinned } }));
  await writeFile(join(directory, "supervisor/state.json"), JSON.stringify({ tailscaleHostname: "saved-name", currentImage: previous }));
  expect(run("plan", "", "", "", "").stdout.split("\n")).toEqual([`ghcr.io/example/system@${pinned}`, "docker.io/example/app:stable", "saved-name"]);
  expect(run("plan", "ghcr.io/lucasmeijer/agents-in-the-cloud", "", "", "").stdout.split("\n")[0]).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud-system:stable");
}));

test("registry-qualified overrides persist on existing installations; local overrides remain one-off", () => fixture(async (directory, run) => {
  expect(run("apply", "", "ghcr.io/example/app:v2", `ghcr.io/example/system@${pinned}`, "saved-name", pinned, previous, "", pinned).status).toBe(0);
  const settings = await readReleaseSettings(join(directory, "app/update.json"));
  expect(releaseReference(settings, "app")).toBe("ghcr.io/example/app:v2");
  expect(run("plan", "", "local-app:test", "local-system:test", "").stdout.split("\n").slice(0, 2)).toEqual(["local-system:test", "local-app:test"]);
  expect(run("apply", "", "local-app:test", "local-system:test", "", pinned, previous, "", pinned).status).toBe(0);
  expect(await readReleaseSettings(join(directory, "app/update.json"))).toEqual(settings);
}));

test.each(["{", "null", "[]", '{"releaseMode":"custom"}', '{"releaseSource":{"appRepository":"bad"}}'])("malformed settings %s do not fall back to upstream", settings => fixture(async (directory, run) => {
  await writeFile(join(directory, "app/update.json"), settings);
  expect(run("plan", "", "", "", "").status).not.toBe(0);
  expect(run("plan", "", "", "", "").stdout).toBe("");
}));

test("invalid hostname and non-pinned apply requests leave settings unchanged", () => fixture(async (directory, run) => {
  await writeFile(join(directory, "app/update.json"), "{}");
  expect(run("apply", "", "", "", "Bad Host", pinned, "", "").status).not.toBe(0);
  expect(run("apply", "", "", "", "valid", "mutable:latest", "", "").status).not.toBe(0);
  expect(await readFile(join(directory, "app/update.json"), "utf8")).toBe("{}");
}));

test("private auth is stored with restrictive permissions, without credential helpers or readback", () => fixture(async (directory, run) => {
  const file = join(directory, "credentials.json");
  const auth = Buffer.from("fixture-user:fixture-token").toString("base64");
  await writeFile(file, JSON.stringify({ auths: { "ghcr.io": { auth } } }));
  const args = ["ghcr.io/example/app", "", "", "valid", pinned, "", file];
  const result = run("credentials", ...args);
  expect(result.status).toBe(0); expect(result.stdout).not.toContain(auth);
  expect((await stat(join(directory, "supervisor/docker-auth"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, "supervisor/docker-auth/config.json"))).mode & 0o777).toBe(0o600);
  await writeFile(file, JSON.stringify({ auths: { "ghcr.io": { auth } }, credsStore: "not-allowed" }));
  expect(run("plan", ...args).status).not.toBe(0);
}));

test("rollback restores a retained app/System pair and keeps the selected release source", () => fixture(async (directory, run) => {
  await writeFile(join(directory, "app/update.json"), JSON.stringify({ releaseMode: "custom", releaseSource: { appRepository: "ghcr.io/example/app", systemRepository: "ghcr.io/example/system" } }));
  await writeFile(join(directory, "supervisor/state.json"), JSON.stringify({ currentImage: pinned, pendingImage: pinned }));
  await writeFile(join(directory, "supervisor/installer.json"), JSON.stringify({ previousSystemImage: previous, previousAppImage: previous }));
  expect(run("rollback-plan", "", "", "", "").stdout.split("\n").slice(0, 2)).toEqual([previous, previous]);
  expect(run("rollback-apply", "", "", "", "", previous, previous, "", pinned).status).toBe(0);
  const state = JSON.parse(await readFile(join(directory, "supervisor/state.json"), "utf8"));
  expect(state.currentImage).toBe(previous); expect(state.pendingImage).toBeUndefined(); expect(state.previousImage).toBe(pinned);
  expect(selectedReleaseChannel(await readReleaseSettings(join(directory, "app/update.json")))).toBe("custom");
}));

test("a saved empty registry config does not require host authentication", () => fixture(async (directory, run) => {
  await mkdir(join(directory, "supervisor/docker-auth"));
  await writeFile(join(directory, "supervisor/docker-auth/config.json"), '{"auths":{}}');
  expect(run("auth-check", "", "", "", "").stdout).toBe("0");
}));

test("an app-only override preserves the active upstream System, not an inactive custom System", () => fixture(async (directory, run) => {
  await writeFile(join(directory, "app/update.json"), JSON.stringify({ releaseMode: "upstream", releaseSource: { appRepository: "ghcr.io/example/inactive-app", systemRepository: "ghcr.io/example/inactive-system" } }));
  expect(run("plan", "", "ghcr.io/example/new-app:v1", "", "").stdout.split("\n")[0]).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud-system:latest");
}));

test("repository arrays are rejected rather than coerced into references", () => fixture(async (directory, run) => {
  await writeFile(join(directory, "app/update.json"), JSON.stringify({ releaseSource: { appRepository: ["ghcr.io/example/app"], systemRepository: "ghcr.io/example/system" } }));
  expect(run("plan", "", "", "", "").status).not.toBe(0);
}));

test("private credential transport uses stdin without placing credentials in command arguments", () => fixture(async (directory) => {
  const auth = Buffer.from("fixture-user:fixture-token").toString("base64");
  const result = Bun.spawnSync(["bun", "-e", helper.replaceAll("/data/", `${directory}/`), "credentials", "", "", "", "valid", "", "", "-"], { stdin: Buffer.from(JSON.stringify({ auths: { "ghcr.io": { auth } } })) });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toContain(auth);
  expect(result.stderr.toString()).not.toContain(auth);
  expect((await stat(join(directory, "supervisor/docker-auth/config.json"))).mode & 0o777).toBe(0o600);
}));
