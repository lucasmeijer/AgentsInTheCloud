import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function dockerResult(stderr: string, exitCode: number) {
  const directory = await mkdtemp(join(tmpdir(), "docker-result-"));
  try {
    const executable = join(directory, "docker");
    await writeFile(executable, `#!/bin/sh\ncat >&2 <<'DOCKER_ERROR'\n${stderr}\nDOCKER_ERROR\nexit ${exitCode}\n`);
    await chmod(executable, 0o755);
    const modulePath = new URL("../src/docker.ts", import.meta.url).href;
    const process = Bun.spawn([Bun.which("bun")!, "--eval", `
      import { requireDocker } from ${JSON.stringify(modulePath)};
      try {
        const result = await requireDocker(["network", "create", "test-network"]);
        console.log(JSON.stringify(result));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message, details: error.details }));
      }
    `], { env: { ...globalThis.process.env, PATH: `${directory}:${globalThis.process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(process.stdout).text();
    const errors = await new Response(process.stderr).text();
    expect(await process.exited, errors).toBe(0);
    return JSON.parse(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Docker address pool exhaustion reports capacity and actionable cleanup guidance", async () => {
  const stderr = "Error response from daemon: all predefined address pools have been fully subnetted";
  const error = await dockerResult(stderr, 1);
  expect(error.code).toBe("docker_network_capacity_exhausted");
  expect(error.message).toContain("Delete workspaces");
  expect(error.message).toContain("Parking a workspace won’t free its network");
  expect(error.message).toContain("default-address-pools");
  expect(error.details).toEqual({ stderr: `${stderr}\n`, command: ["network", "create", "test-network"] });
});

test("other Docker failures preserve their original diagnostic", async () => {
  const error = await dockerResult("Cannot connect to the Docker daemon", 1);
  expect(error).toEqual({ code: "docker_unavailable", message: "Cannot connect to the Docker daemon" });
});

test("empty Docker failure output preserves the command fallback", async () => {
  const error = await dockerResult("", 1);
  expect(error).toEqual({ code: "docker_unavailable", message: "docker network failed" });
});

test("successful Docker commands are not classified from stderr", async () => {
  const result = await dockerResult("all predefined address pools have been fully subnetted", 0);
  expect(result.exitCode).toBe(0);
});
