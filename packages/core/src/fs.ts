import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function writeFileAtomic(path: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, data, { mode: options.mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeJsonAtomic<Value>(path: string, value: Value, options: { mode?: number } = {}): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}
