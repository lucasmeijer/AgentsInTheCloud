export async function command(args: string[], timeout = 5000): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr.trim() || `${args[0]} failed or timed out (exit ${code})`);
    return stdout.trimEnd();
  } finally { clearTimeout(timer); }
}
