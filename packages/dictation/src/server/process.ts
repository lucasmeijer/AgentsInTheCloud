export function spawnTranscriptionProcess(command: string[], cacheDir: string) {
  return Bun.spawn([
    "setpriv", "--pdeathsig", "SIGKILL", "--",
    // Check after arming the death signal: the server may have exited before setpriv ran.
    // Both setpriv and sh exec in place, so the model remains our direct child.
    "sh", "-c", 'test "$PPID" -eq "$1" || exit 1; shift; exec "$@"',
    "transcription", String(process.pid), ...command,
  ], {
    env: { ...process.env, XDG_CACHE_HOME: cacheDir },
    stdout: "inherit",
    stderr: "pipe",
  });
}
