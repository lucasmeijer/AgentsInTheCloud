import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireReleaseLock } from "./release-lock.ts";

function contender(path: string, hold = false) {
  return Bun.spawn([process.execPath, "--eval", `
    import { acquireReleaseLock } from ${JSON.stringify(join(import.meta.dir, "release-lock.ts"))};
    const unlock = acquireReleaseLock(${JSON.stringify(path)});
    if (!unlock) process.exit(75);
    ${hold ? 'console.log("locked"); setInterval(() => {}, 1000);' : "unlock();"}
  `], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

test("release lock excludes other processes and can be reacquired after closing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agents-in-the-cloud-release-lock-"));
  const path = join(directory, "release.lock");
  try {
    const unlock = acquireReleaseLock(path)!;
    expect(unlock).toBeFunction();
    try {
      expect(await contender(path).exited).toBe(75);
    } finally {
      unlock();
    }
    expect(await contender(path).exited).toBe(0);
    expect(await contender(path).exited).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("kernel releases the lock when its owner is killed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agents-in-the-cloud-release-lock-"));
  const path = join(directory, "release.lock");
  const owner = contender(path, true);
  try {
    const reader = owner.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("locked\n");
    reader.releaseLock();
    expect(await contender(path).exited).toBe(75);
    owner.kill("SIGKILL");
    await owner.exited;
    expect(await contender(path).exited).toBe(0);
  } finally {
    owner.kill();
    await owner.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lock filesystem failures are errors, not contention", () => {
  const directory = mkdtempSync(join(tmpdir(), "agents-in-the-cloud-release-lock-"));
  try {
    expect(() => acquireReleaseLock(directory)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
