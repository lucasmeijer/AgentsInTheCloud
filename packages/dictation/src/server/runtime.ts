import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const version = "0.1.0";
const installations = new Map<string, Promise<string>>();

export function ensureTranscriptionRuntime(cacheDir: string): Promise<string> {
  const bundled = Bun.which("nemo-speech");
  if (bundled) return Promise.resolve(bundled);

  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error(`NeMo Speech requires Linux x64 or arm64; got ${process.platform} ${process.arch}`);
  }
  const architecture = process.arch === "x64" ? "x86_64" : "aarch64";
  const directory = join(cacheDir, "runtimes", `nemo-speech-${version}-linux-${architecture}-cpu`);
  const pending = installations.get(directory);
  if (pending) return pending;
  const installation = installRuntime(directory, architecture).finally(() => installations.delete(directory));
  installations.set(directory, installation);
  return installation;
}

async function download(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`NeMo Speech download failed: ${response.status} ${response.statusText} (${url})`);
  return response;
}

async function installRuntime(directory: string, architecture: string): Promise<string> {
  const executable = join(directory, "bin", "nemo-speech");
  if (await Bun.file(executable).exists()) return executable;

  const archive = `nemo-speech-${version}-linux-${architecture}-cpu.tar.gz`;
  const releaseUrl = `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${version}`;
  await mkdir(join(directory, ".."), { recursive: true });
  const temporary = await mkdtemp(`${directory}.partial-`);
  try {
    const checksum = await (await download(`${releaseUrl}/${archive}.sha256`)).text();
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(checksum);
    if (!match || match[2] !== archive) throw new Error("Invalid NeMo Speech release checksum file");

    const archivePath = join(temporary, archive);
    await Bun.write(archivePath, await download(`${releaseUrl}/${archive}`));
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(archivePath).stream()) hash.update(chunk);
    if (hash.digest("hex") !== match[1]!.toLowerCase()) throw new Error("NeMo Speech archive checksum mismatch");

    const extracted = join(temporary, "runtime");
    await mkdir(extracted);
    const child = Bun.spawn(["tar", "-xzf", archivePath, "--strip-components=1", "-C", extracted], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`NeMo Speech extraction failed (${exitCode}): ${stderr.trim()}`);
    await access(join(extracted, "bin", "nemo-speech"), constants.X_OK);
    await rename(extracted, directory);
    return executable;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
