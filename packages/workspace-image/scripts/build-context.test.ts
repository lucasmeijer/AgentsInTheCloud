import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspaceImageMetadata } from "../src/metadata.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoots: string[] = [];
afterAll(async () => { await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true }))); });

async function generateContext(fixture: string) {
  const output = join(fixture, "output");
  const process = Bun.spawnSync(["bun", join(fixture, "packages/workspace-image/scripts/build-context.mjs"), output], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return { fixture, output, metadata: await Bun.file(join(output, "metadata.json")).text(), dockerfile: await Bun.file(join(output, "Dockerfile")).text() };
}

async function generateInCheckout() {
  const fixture = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-image-context-"));
  temporaryRoots.push(fixture);
  await cp(join(root, "packages"), join(fixture, "packages"), { recursive: true });
  return generateContext(fixture);
}

describe("workspace image content identity", () => {
  test("validates generated metadata before consumers use it", () => {
    expect(parseWorkspaceImageMetadata({ tag: "agents-in-the-cloud-workspace:abc", modules: ["base"] })).toEqual({
      tag: "agents-in-the-cloud-workspace:abc",
      modules: ["base"],
    });
    expect(() => parseWorkspaceImageMetadata({ tag: 42, modules: ["base"] })).toThrow();
    expect(() => parseWorkspaceImageMetadata({ tag: "agents-in-the-cloud-workspace:abc" })).toThrow();
  });

  test.each([
    ["systemd bootstrap script", "packages/workspace-image/rootfs/usr/local/bin/agents-in-the-cloud-workspace-init", "files/base/rootfs/usr/local/bin/agents-in-the-cloud-workspace-init", "#"],
    ["Docker capability guard", "packages/workspace-image/rootfs/usr/local/bin/docker", "files/base/rootfs/usr/local/bin/docker", "#"],
  ])("%s is packaged and changes the default image identity", async (_name, sourcePath, packagedPath, comment) => {
    const before = await generateInCheckout();
    const source = join(before.fixture, sourcePath);
    await appendFile(source, `\n${comment} image identity probe\n`);
    const after = await generateContext(before.fixture);
    expect(await Bun.file(join(after.output, packagedPath)).text()).toBe(await Bun.file(source).text());
    expect(after.metadata).not.toBe(before.metadata);
  });

  test("generated Dockerfile and file permissions participate in identity", async () => {
    const before = await generateInCheckout();
    const generator = join(before.fixture, "packages/workspace-image/scripts/build-context.mjs");
    await writeFile(generator, (await readFile(generator, "utf8")).replace("WORKDIR /work", "WORKDIR /changed-work"));
    const instructionChange = await generateContext(before.fixture);
    expect(instructionChange.metadata).not.toBe(before.metadata);
    await chmod(join(before.fixture, "packages/workspace-image/rootfs/usr/local/bin/agents-in-the-cloud-workspace-init"), 0o700);
    const permissionChange = await generateContext(before.fixture);
    expect(permissionChange.metadata).not.toBe(instructionChange.metadata);
  });

  test("adds mounted tools to the inherited PATH and restores them for login shells", async () => {
    const { dockerfile, output } = await generateInCheckout();
    expect(dockerfile).toContain('PATH="/opt/agents-in-the-cloud/bin:${PATH}"');
    const profile = await readFile(join(output, "files/base/rootfs/etc/profile.d/agents-in-the-cloud-tools.sh"), "utf8");
    const result = Bun.spawnSync(["/bin/sh", "-ec", `${profile}\nprintf '%s' "$PATH"`], {
      env: { PATH: "/custom/bin:/usr/bin:/bin" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("/opt/agents-in-the-cloud/bin:/custom/bin:/usr/bin:/bin");
  });

  test("mounted helper changes do not change the image or its identity", async () => {
    const before = await generateInCheckout();
    for (const [packageName, name] of [
      ["desktop", "agents-in-the-cloud-desktop"],
      ["vscode", "agents-in-the-cloud-start-vscode"],
      ["workspace-terminal", "pbcopy"],
      ["workspace-image", "chromium"],
    ]) {
      expect(before.dockerfile).not.toContain(`/usr/local/bin/${name}`);
      await appendFile(join(before.fixture, "packages", packageName!, "workspace_tools", name!), "\n# mounted helper update\n");
    }
    const after = await generateContext(before.fixture);
    expect(after.metadata).toBe(before.metadata);
    expect(after.dockerfile).toBe(before.dockerfile);
  });

  test("equivalent checkouts at different absolute paths produce identical output", async () => {
    const [left, right] = await Promise.all([generateInCheckout(), generateInCheckout()]);
    expect(left.metadata).toBe(right.metadata);
    expect(left.dockerfile).toBe(right.dockerfile);
  });
});

describe("workspace image layer ordering", () => {
  test("installs module dependencies before their setup, after heavyweight tooling", async () => {
    const { dockerfile } = await generateInCheckout();
    const moduleBlock = (name: string) => dockerfile.split(`# Module: ${name}\n`)[1]!.split("# Module:")[0]!.split("# Files independent")[0]!;
    const base = moduleBlock("base");
    const lastAptLayer = (block: string) => block.lastIndexOf("bash /tmp/apt-layer.sh");
    expect(lastAptLayer(base)).toBeGreaterThan(-1);
    expect(lastAptLayer(base)).toBeLessThan(base.indexOf("npm install -g playwright"));
    expect(base).not.toContain("      socat");
    expect(base).not.toContain("      openbox");
    expect(base).not.toContain("      tmux");
    expect(moduleBlock("proxy-egress")).toContain("      socat");
    expect(moduleBlock("workspace-terminal")).toContain("tmux-$tmux_version.tar.gz");
    const desktop = moduleBlock("desktop");
    expect(desktop).toContain("      openbox");
    expect(lastAptLayer(desktop)).toBeGreaterThan(-1);
    expect(lastAptLayer(desktop)).toBeLessThan(desktop.indexOf("RUN glib-compile-schemas"));
    expect(dockerfile.indexOf("# Module: base")).toBeLessThan(dockerfile.indexOf("# Module: vscode"));
    expect(dockerfile.indexOf("# Module: vscode")).toBeLessThan(dockerfile.indexOf("# Module: desktop"));
  });

  test("changing feature dependencies preserves preceding build instructions", async () => {
    const before = await generateInCheckout();
    const manifest = join(before.fixture, "packages/proxy-egress/workspace-image.json");
    await writeFile(manifest, JSON.stringify({ aptPackages: ["socat", "strace", "socat"] }));
    const after = await generateContext(before.fixture);
    expect(after.metadata).not.toBe(before.metadata);
    const prefix = (dockerfile: string) => dockerfile.split("# Module: proxy-egress\n")[0];
    expect(prefix(after.dockerfile)).toBe(prefix(before.dockerfile));
    expect(after.dockerfile.match(/      socat/g)).toHaveLength(1);
    expect(after.dockerfile).toContain("      socat \\\n      strace");
  });

  test("spreads a large module's apt install over several layers", async () => {
    const { dockerfile, output } = await generateInCheckout();
    const moduleBlock = (name: string) => dockerfile.split(`# Module: ${name}\n`)[1]!.split("# Module:")[0]!;
    const layers = (name: string) => [...moduleBlock(name).matchAll(/bash \/tmp\/apt-layer.sh (\d+) (\d+) \\\n/g)].map((match) => `${match[1]}/${match[2]}`);
    expect(layers("base")).toEqual(["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
    expect(layers("desktop")).toEqual(["1/1"]);
    expect(layers("proxy-egress")).toEqual(["1/1"]);
    expect(await readFile(join(output, "apt-layer.sh"), "utf8")).toBe(await readFile(join(root, "packages/workspace-image/scripts/apt-layer.sh"), "utf8"));
  });

  test.each([
    ["packages/workspace-image/rootfs/usr/local/bin/agents-in-the-cloud-workspace-init", "files/base/rootfs/usr/local/bin/agents-in-the-cloud-workspace-init"],
  ])("copies runtime script %s only after module setup", async (sourcePath, packagedPath) => {
    const before = await generateInCheckout();
    const copy = `COPY ${JSON.stringify(packagedPath)}`;
    expect(before.dockerfile.indexOf(copy)).toBeGreaterThan(before.dockerfile.indexOf("# Files independent of module setup"));
    await appendFile(join(before.fixture, sourcePath), "\n# cache boundary probe\n");
    const after = await generateContext(before.fixture);
    expect(after.metadata).not.toBe(before.metadata);
    expect(after.dockerfile.split("LABEL com.agents-in-the-cloud.workspace-image.signature=")[0]).toBe(before.dockerfile.split("LABEL com.agents-in-the-cloud.workspace-image.signature=")[0]);
    expect(await readFile(join(after.output, packagedPath), "utf8")).toContain("# cache boundary probe");
  });
});
