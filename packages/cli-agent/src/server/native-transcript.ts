import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "@agents-in-the-cloud/core";
import type { TSchema, Static } from "typebox";
import { Compile } from "typebox/compile";

/** Native CLI histories are append-only; the last line can still be in flight. */
export function* nativeJsonlRows<T extends TSchema>(jsonl: string, schema: T): Generator<Static<T>> {
  // Value.Check resolves the schema on every call; a long history needs one validator.
  const validator = Compile(schema);
  const lines = jsonl.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
    if (validator.Check(parsed)) {
      // SAFETY: The compiled validator validated the parsed row against the supplied schema.
      yield parsed as Static<T>;
    }
  }
}

async function nativeJsonlFiles(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await nativeJsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

/** Session files in chronological order, oldest first. */
export async function nativeSessionFiles(directory: string): Promise<string[]> {
  return (await nativeJsonlFiles(directory)).sort();
}

/** The newest session file, which a resumed CLI continues. */
export async function latestNativeSessionFile(directory: string): Promise<string | undefined> {
  return (await nativeSessionFiles(directory)).at(-1);
}

export async function loadNativeTranscriptFiles<T>(files: string[], parse: (jsonl: string, file: string) => T[]): Promise<T[] | undefined> {
  if (!files.length) return undefined;
  return (await Promise.all(files.map(async (file) => parse(await readFile(file, "utf8"), file)))).flat();
}

export async function loadNativeTranscriptImage(files: string[], find: (jsonl: string, file: string) => { data: string; mimeType: string } | undefined): Promise<Response> {
  for (const file of files) {
    const image = find(await readFile(file, "utf8"), file);
    if (image) return nativeImageResponse(image.data, image.mimeType);
  }
  return new Response("Not found", { status: 404 });
}

export function nativeTimestamp(value: string | undefined): number {
  return Date.parse(value ?? "") || 0;
}

export const nativeImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function nativeImageResponse(data: string, mimeType: string): Response {
  const bytes = Buffer.from(data, "base64");
  return new Response(bytes, { headers: { "Content-Type": mimeType, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" } });
}
