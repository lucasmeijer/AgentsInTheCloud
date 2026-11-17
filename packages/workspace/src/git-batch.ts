import type { WorkingFileRevision, WorkingFileWriteResult, GitResult } from "./git-repository.ts";

export type RepositoryRequest = { kind: "git"; args: string[] } | { kind: "working-file"; path: string; maxBytes: number; editable?: true } | { kind: "blob"; object: string; maxBytes: number } | { kind: "index-tree" } | { kind: "write-working-file"; path: string; expected: WorkingFileRevision; contents: string };

export function decodeWorkingFileWrite(result: GitResult): WorkingFileWriteResult {
  if (result.exitCode === 73) return "changed";
  if (result.exitCode === 45) return "unsupported";
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Couldn’t save workspace file");
  return "saved";
}

export const repositoryBatchRunner = String.raw`
const { lstat, readFile, readlink, mkdtemp, copyFile, rm, open, rename } = require('node:fs/promises');
const { resolve, join, relative, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const requests = JSON.parse(await Bun.stdin.text());
async function execute(args, env, stdin) {
  const child = Bun.spawn(args, { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', env });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(), child.exited]);
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode };
}
// Content larger than its bound is reported by size alone (exit 46), so a huge file never reaches memory.
async function boundedRead(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size: expected } = await handle.stat();
    if (expected > maxBytes) return { size: expected };
    // The file may grow after stat; end is inclusive, so reading one byte past the bound detects that.
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ end: maxBytes, autoClose: false })) { chunks.push(chunk); size += chunk.length; }
    return size > maxBytes ? { size: (await handle.stat()).size } : { size, contents: Buffer.concat(chunks) };
  } finally { await handle.close(); }
}
async function run(request) {
  if (request.kind === 'git') return execute(request.args);
  if (request.kind === 'blob') {
    const missing = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 44 };
    const resolved = await execute([...request.resolveArgs, request.object]);
    if (resolved.exitCode !== 0) return missing;
    // Pin the object id so the size check and the read see the same blob.
    const id = resolved.stdout.toString().trim();
    const check = await execute(request.checkArgs, undefined, id + '\n');
    if (check.exitCode !== 0) return check;
    const [, type, size] = check.stdout.toString().trim().split(' ');
    if (type !== 'blob') return missing;
    if (Number(size) > request.maxBytes) return { stdout: Buffer.from(size), stderr: Buffer.alloc(0), exitCode: 46 };
    return execute([...request.readArgs, id]);
  }
  if (request.kind === 'write-working-file') {
    const result = exitCode => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode });
    if (!request.path || request.path.startsWith('/') || request.path.includes('\0') || request.path.split('/').some(part => part === '..' || part === '.git')) return result(45);
    const path = resolve(request.path), within = relative(process.cwd(), path);
    if (!within || within === '..' || within.startsWith('..' + sep)) return result(45);
    // Hold directory descriptors and use their proc paths. A renamed or swapped
    // ancestor cannot redirect the write through a symlink between checks.
    const directories = [];
    async function parentDirectory() {
      let directory = await open(process.cwd(), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push(directory);
      for (const part of within.split(sep).slice(0, -1)) {
        directory = await open('/proc/self/fd/' + directory.fd + '/' + part, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        directories.push(directory);
      }
      return '/proc/self/fd/' + directory.fd;
    }
    let handle, temporary;
    try {
      const directory = await parentDirectory();
      const target = directory + '/' + within.split(sep).at(-1);
      const entry = await lstat(target);
      if (!entry.isFile()) return result(45);
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      const original = await handle.readFile();
      const hash = bytes => createHash('sha256').update(bytes).digest('hex');
      const mode = info.mode & 0o111 ? '100755' : '100644';
      if (hash(original) !== request.expected.hash || mode !== request.expected.mode) return result(73);
      if (original.equals(Buffer.from(request.contents, 'utf8'))) return result(0);
      // Honor the workspace user's file permissions even when directory replacement is allowed.
      const writable = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW);
      await writable.close();
      temporary = directory + '/.agents-in-the-cloud-edit-' + randomUUID();
      const output = await open(temporary, 'wx', 0o600);
      try {
        await output.writeFile(request.contents, 'utf8');
        await output.chmod(info.mode & 0o777);
        await output.sync();
      } finally { await output.close(); }
      const latest = await lstat(target);
      if (!latest.isFile() || latest.ino !== info.ino || latest.dev !== info.dev || latest.mode !== info.mode || hash(await readFile(target)) !== request.expected.hash) return result(73);
      await rename(temporary, target);
      return result(0);
    } catch (error) {
      if (error.code === 'ENOENT') return result(73);
      if (error.code === 'ELOOP' || error.code === 'ENOTDIR') return result(45);
      throw error;
    } finally {
      if (handle) await handle.close();
      if (temporary) await rm(temporary, { force: true });
      for (const directory of directories.reverse()) await directory.close();
    }
  }
  if (request.kind === 'working-file') {
    const path = resolve(request.path), within = relative(process.cwd(), path);
    if (within === '..' || within.startsWith('..' + sep)) throw new Error('File path escapes repository');
    try {
      if (request.editable) {
        if (!request.path || request.path.split('/').some(part => part === '..' || part === '.git')) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 44 };
        let parent = process.cwd();
        for (const part of within.split(sep).slice(0, -1)) {
          parent = join(parent, part);
          if (!(await lstat(parent)).isDirectory()) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 44 };
        }
      }
      const info = await lstat(path);
      if (request.editable && !info.isFile()) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 44 };
      if (!info.isFile() && !info.isSymbolicLink()) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 44 };
      const mode = info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644';
      const { size, contents } = info.isSymbolicLink() ? { size: info.size, contents: Buffer.from(await readlink(path)) } : await boundedRead(path, request.maxBytes);
      if (!contents) return { stdout: Buffer.from(mode + '\n' + size), stderr: Buffer.alloc(0), exitCode: 46 };
      return { stdout: Buffer.concat([Buffer.from(mode + '\n'), contents]), stderr: Buffer.alloc(0), exitCode: 0 };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 44 };
      throw error;
    }
  }
  if (request.kind !== 'index-tree') throw new Error('Unknown repository request');
  const directory = await mkdtemp(join(tmpdir(), 'changes-index-'));
  try {
    const index = await execute(request.args);
    if (index.exitCode !== 0) return index;
    try { await copyFile(resolve(index.stdout.toString().trim()), join(directory, 'index')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return await execute(request.writeArgs, { ...process.env, GIT_INDEX_FILE: join(directory, 'index') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
// Bounded parallelism inside one exec; output is ordered and byte-length framed.
const results = new Array(requests.length);
let cursor = 0;
const completed = await Promise.allSettled(Array.from({ length: Math.min(4, requests.length) }, async () => {
  while (cursor < requests.length) { const position = cursor++; results[position] = await run(requests[position]); }
}));
const failed = completed.find(result => result.status === 'rejected');
if (failed) throw failed.reason;
for (const result of results) {
  const header = Buffer.alloc(12);
  header.writeInt32BE(result.exitCode, 0);
  header.writeUInt32BE(result.stdout.length, 4);
  header.writeUInt32BE(result.stderr.length, 8);
  process.stdout.write(header); process.stdout.write(result.stdout); process.stdout.write(result.stderr);
}
`;

export function decodeRepositoryBatch(output: Buffer, count: number): GitResult[] {
  const results: GitResult[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 12 > output.length) throw new Error("Truncated repository batch header");
    const exitCode = output.readInt32BE(offset);
    const stdoutLength = output.readUInt32BE(offset + 4), stderrLength = output.readUInt32BE(offset + 8);
    offset += 12;
    if (offset + stdoutLength + stderrLength > output.length) throw new Error("Truncated repository batch payload");
    const stdout = output.subarray(offset, offset + stdoutLength);
    offset += stdoutLength;
    const stderr = output.subarray(offset, offset + stderrLength).toString();
    offset += stderrLength;
    results.push({ exitCode, stdout, stderr });
  }
  if (offset !== output.length) throw new Error("Unexpected repository batch payload");
  return results;
}
