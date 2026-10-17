/**
 * Builds a static Linux binary with the local Go toolchain. Always run it: Go's
 * content-addressed build cache makes an unchanged build take about 0.1 s.
 * Imports nothing, so scripts can load it from a bare checkout.
 */
export async function buildGoProgram(directory: string, output: string, platform: string): Promise<void> {
  const [os, arch] = platform.split("/");
  const build = Bun.spawn(["go", "build", "-trimpath", "-ldflags=-s -w", "-o", output, "."], {
    cwd: directory,
    env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  if (exitCode !== 0) throw new Error(`go build failed for ${directory} (${platform}):\n${stderr}`);
}

/** Runs a Go module's tests, for `bun test`. */
export async function runGoTests(directory: string): Promise<void> {
  const test = Bun.spawn(["go", "test", "./..."], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(test.stdout).text(), new Response(test.stderr).text(), test.exited]);
  if (exitCode !== 0) throw new Error(`go test failed in ${directory}:\n${stdout}${stderr}`);
}
