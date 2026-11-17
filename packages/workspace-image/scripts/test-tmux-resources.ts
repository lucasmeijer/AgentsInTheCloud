// bun packages/workspace-image/scripts/test-tmux-resources.ts <local-workspace-image>
// Tests current source in a disposable, memory-limited Linux container.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runDocker, shellQuote } from "@agents-in-the-cloud/core";
import { workspaceRuntimeUnits } from "../src/workspace-systemd-units.ts";

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Pass a local workspace image containing systemd, tmux and Python");
const name = `agents-in-the-cloud-tmux-resources-${crypto.randomUUID()}`;
async function docker(args: string[], input?: string, check = true) {
  const result = await runDocker(args, { stdin: input });
  if (check) assert.equal(result.exitCode, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function exec(...args: string[]) { return (await docker(["exec", name, ...args])).stdout.trim(); }
try {
  await docker(["create", "--name", name, "--security-opt", "writable-cgroups=true", "--cgroupns=private", "--memory=512m", "--memory-swap=512m", "--tmpfs", "/run",
    "--env", "HOME=/root", "--env", "USER=root", "--env", "LOGNAME=root", "--env", "SHELL=/bin/sh", "--env", "LANG=C.UTF-8",
    "--entrypoint", "/bin/bash", image, "-ec", "rm -f /etc/systemd/system/agents-in-the-cloud-gateway.service /usr/lib/systemd/system/agents-in-the-cloud-gateway.service; exec /usr/local/bin/agents-in-the-cloud-workspace-init"]);
  const bootstrap = fileURLToPath(new URL("../rootfs/usr/local/bin/agents-in-the-cloud-workspace-init", import.meta.url));
  await docker(["cp", bootstrap, `${name}:/usr/local/bin/agents-in-the-cloud-workspace-init`]);
  await docker(["start", name]);
  for (let attempt = 0; ; attempt++) {
    const ready = await docker(["exec", name, "systemctl", "show", "--property=Version"], undefined, false);
    if (ready.exitCode === 0) break;
    assert.ok(attempt < 100, `systemd did not start: ${ready.stderr}`);
    await Bun.sleep(100);
  }
  for (const [unit, content] of Object.entries(workspaceRuntimeUnits())) {
    await docker(["exec", "-i", name, "tee", `/etc/systemd/system/${unit}`], content);
  }
  const environment = await exec("cat", "/.agents-in-the-cloud/environment");
  assert.doesNotMatch(environment, /^(HOME|USER|LOGNAME|SHELL)=/m);
  assert.match(environment, /^LANG="C.UTF-8"$/m);
  await exec("sh", "-ec", "sed -i -E 's/^(agents-in-the-cloud:[^:]*:)[0-9]+:[0-9]+:/\\12345:2345:/' /etc/passwd; sed -i -E 's/^(agents-in-the-cloud:[^:]*:)[0-9]+:/\\12345:/' /etc/group; chown agents-in-the-cloud:agents-in-the-cloud /work /home/agents-in-the-cloud");
  await docker(["exec", "-i", name, "tee", "/.agents-in-the-cloud/init.sh"], 'set -e\nsystemctl start agents-in-the-cloud-tmux.service\nsu agents-in-the-cloud -c "tmux -N show-options -g" > /tmp/init-tmux-options\n');
  await exec("systemctl", "daemon-reload");
  await exec("systemctl", "start", "agents-in-the-cloud-init.service");
  assert.ok((await exec("cat", "/tmp/init-tmux-options")).length > 0);
  const serverPid = await exec("systemctl", "show", "-p", "MainPID", "--value", "agents-in-the-cloud-tmux.service");
  assert.notEqual(serverPid, "0");
  await exec("systemd-run", "--unit=resource-test-gateway", "/bin/sleep", "infinity");
  const uid = await exec("id", "-u", "agents-in-the-cloud");
  const probe = `
    test "$(id -u)" = ${uid} && test "$HOME" = /home/agents-in-the-cloud && test "$PWD" = /work || exit 90
    test "$USER" = agents-in-the-cloud && test "$LOGNAME" = agents-in-the-cloud && test "$SHELL" = /bin/bash || exit 91
    test "$LANG" = C.UTF-8 || exit 94
    test "$(cat /proc/self/oom_score_adj)" = 500 || exit 92
    test "$(ps -o ni= -p $$ | tr -d ' ')" = 10 || exit 93
    group=$(sed -n 's/^0:://p' /proc/self/cgroup)
    test "$group" = /system.slice/agents-in-the-cloud-tmux.service || exit 95
  `;
  async function pane(session: string, command: string) {
    await docker(["exec", "--user", "agents-in-the-cloud", "--workdir", "/work", name, "sh", "-c", `tmux -N new-session -d -s ${shellQuote(session)} -c /work ${shellQuote(command)}`]);
  }
  async function waitFile(path: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await docker(["exec", name, "cat", path], undefined, false);
      if (result.exitCode === 0 && result.stdout !== "") return result.stdout.trim();
      await Bun.sleep(100);
    }
    throw new Error(`Timed out waiting for ${path}`);
  }
  await pane("direct", `bash -c ${shellQuote(`${probe}
exit 17`)}; printf '%s' "$?" > /tmp/direct-exit`);
  assert.equal(await waitFile("/tmp/direct-exit"), "17");
  assert.equal(await exec("cat", "/sys/fs/cgroup/system.slice/agents-in-the-cloud-tmux.service/cpu.weight"), "10");
  // A client in a pane asks the existing server to launch a dev server. Both
  // must inherit the policy, unlike the former per-Bash wrapper.
  await docker(["exec", "-i", name, "tee", "/tmp/nested.sh"], `${probe}
printf '%s' "$?" > /tmp/nested-exit
sleep infinity
`);
  await pane("launcher", 'tmux new-session -d -s devserver "bash /tmp/nested.sh"');
  assert.equal(await waitFile("/tmp/nested-exit"), "0");
  await exec("systemctl", "set-property", "--runtime", "agents-in-the-cloud-tmux.service", "MemoryMax=128M", "MemorySwapMax=0");
  await pane("memory", `python3 -c 'import os
assert os.isatty(0)
a=[]
while True: a.append(bytearray(8*1024*1024))'
printf '%s' "$?" > /tmp/command-exit`);
  assert.equal(await waitFile("/tmp/command-exit"), "137");
  assert.equal(await exec("systemctl", "is-active", "resource-test-gateway"), "active");
  assert.equal(await exec("systemctl", "show", "-p", "MainPID", "--value", "agents-in-the-cloud-tmux.service"), serverPid);
  await exec("su", "agents-in-the-cloud", "-c", "tmux kill-session -t devserver");
  await Bun.sleep(200);
  assert.equal(await exec("systemctl", "show", "-p", "MainPID", "--value", "agents-in-the-cloud-tmux.service"), serverPid);
  await exec("kill", "-KILL", serverPid);
  for (let attempt = 0; ; attempt++) {
    const ready = await docker(["exec", name, "systemctl", "is-active", "--quiet", "agents-in-the-cloud-tmux.service"], undefined, false);
    const pid = await exec("systemctl", "show", "-p", "MainPID", "--value", "agents-in-the-cloud-tmux.service");
    if (ready.exitCode === 0 && pid !== serverPid && pid !== "0") break;
    assert.ok(attempt < 100, "systemd must restart the tmux server");
    await Bun.sleep(100);
  }
  assert.equal(await exec("systemctl", "is-active", "agents-in-the-cloud-init.service"), "active");
  await pane("restarted", `bash -c ${shellQuote(probe)}; printf '%s' "$?" > /tmp/restarted-exit`);
  assert.equal(await waitFile("/tmp/restarted-exit"), "0");
  await exec("systemctl", "stop", "agents-in-the-cloud-tmux.service");
  const unmanaged = await docker(["exec", "--user", "agents-in-the-cloud", name, "sh", "-c", "tmux -N new-session -d -s unmanaged -c /work 'sleep 60'"], undefined, false);
  assert.notEqual(unmanaged.exitCode, 0, "workspace calls must not auto-start an unmanaged server");
  await exec("mkdir", "-p", "/run/systemd/system/agents-in-the-cloud-tmux.service.d");
  await docker(["exec", "-i", name, "tee", "/run/systemd/system/agents-in-the-cloud-tmux.service.d/failure.conf"], "[Service]\nExecStart=\nExecStart=/bin/false\nRestart=no\n");
  await exec("systemctl", "daemon-reload");
  const failedInit = await docker(["exec", name, "systemctl", "restart", "agents-in-the-cloud-init.service"], undefined, false);
  assert.notEqual(failedInit.exitCode, 0, "initialization must fail if the managed server cannot start");
  console.log("PASS: supervised tmux ready before project hooks with aligned UID/GID; direct and nested panes inherit identity, cgroup, CPU and OOM policy; PTY and completion survive workload OOM; gateway survives; empty server persists; crash recovery restores managed placement; no unmanaged auto-start; failed server blocks initialization");
} finally {
  await docker(["rm", "-f", name]);
}
