import { expect, test } from "bun:test";

const installer = await Bun.file(new URL("./install.sh", import.meta.url)).text();

function run(options: { systemState?: "restarting" | "exited"; adminMappings?: string; nonRoot?: boolean; denySudo?: boolean; mac?: boolean; wsl?: boolean; installed?: boolean; old?: boolean; legacyAtelier?: boolean; legacyVolumeOnly?: boolean; legacyPreSystem?: boolean; legacyDownloadFails?: boolean; legacyDelegateFails?: boolean; pullFails?: boolean; appFails?: boolean; retryUpdateRequest?: boolean; rejectUpdateRequest?: boolean; pendingHealth?: boolean; missingFilesystem?: boolean; loadable?: boolean; uninstallAnswer?: string; uninstallFails?: boolean; uninstallRequestFails?: boolean; inventoryFails?: boolean; volumeOnly?: boolean; volumeRemovalFails?: boolean; initiallyStopped?: boolean } = {}, args: string[] = []) {
  const logPath = `/tmp/agents-in-the-cloud-install-test-${crypto.randomUUID()}.log`;
  const mock = `
mktemp() { if [[ "$*" == *atelier-legacy-uninstall* ]]; then echo "${logPath}.legacy"; else echo "${logPath}"; fi; }
curl() { printf 'CURL %s\\n' "$*" >&2; return ${options.legacyDownloadFails ? 22 : 0}; }
bash() { printf 'LEGACY BASH %s\\n' "$*" >&2; return ${options.legacyDelegateFails ? 1 : 0}; }
sleep() { command sleep 0.01; }
uname() { echo ${options.mac ? "Darwin" : "Linux"}; }
id() { echo ${options.mac || options.nonRoot ? 501 : 0}; }
sudo() {
  printf 'SUDO %s\\n' "$*" >&2
  if [ "$1" = -v ]; then return ${options.denySudo ? 1 : 0}; fi
  "$@"
}
module_loaded=0
container_present=${options.installed ? 1 : 0}
volume_present=${options.installed || options.volumeOnly ? 1 : 0}
grep() { if [[ "$*" == *microsoft* ]]; then return ${options.wsl ? 0 : 1}; fi; [ "$module_loaded" -eq 1 ] || return ${options.missingFilesystem ? 1 : 0}; }
modprobe() {
  printf 'MODPROBE %s\\n' "$*" >&2
  module_loaded=1
  return ${options.missingFilesystem && !options.loadable ? 1 : 0};
}
mkdir() { :; }
docker() {
  printf 'DOCKER %s\\n' "$*" >&2
  case "$1 \${2:-}" in
    'container inspect')
      case "$3" in
        agents-in-the-cloud-system) return ${options.installed ? 0 : 1} ;;
        agents-in-the-cloud) return ${options.old ? 0 : 1} ;;
        atelier-system) return ${options.legacyAtelier ? 0 : 1} ;;
        atelier) return ${options.legacyPreSystem ? 0 : 1} ;;
      esac ;;
    'pull '*) return ${options.pullFails ? 1 : 0} ;;
    'volume ls') if [[ "$*" == *'name=^atelier-system$'* ]]; then if [ "${options.legacyVolumeOnly ? 1 : 0}" -eq 1 ]; then echo atelier-system; fi; return 0; fi; if [ "$volume_present" -eq 1 ] && [ ! -e "${logPath}.volume-removed" ]; then echo agents-in-the-cloud-system; fi; return 0 ;;
    'volume rm')
      if [ "${options.volumeRemovalFails ? 1 : 0}" -eq 1 ]; then return 1; fi
      touch "${logPath}.volume-removed"; return 0 ;;
    'ps -a') if [ "$container_present" -eq 1 ] && [ ! -e "${logPath}.container-removed" ]; then echo agents-in-the-cloud-system; fi; return 0 ;;
    'rm agents-in-the-cloud-system') touch "${logPath}.container-removed"; return 0 ;;
    'exec --user')
      if [[ "$*" == *http://supervisor/uninstall* ]]; then
        if [[ "$*" == *'method:"POST"'* ]]; then return ${options.uninstallRequestFails ? 1 : 0}; fi
        if [ "${options.inventoryFails ? 1 : 0}" -eq 1 ]; then return 2; fi
        printf '8\\n${"a".repeat(64)}\\n'; return 0
      fi
      if [[ "$*" == *3001/status* ]]; then
        printf '${options.uninstallFails ? "failed\\nvolume is in use" : "complete\\nManaged resources deleted"}\\n'; return 0
      fi ;;
    'exec agents-in-the-cloud-system')
      if [[ "$*" == *3001/update-channel* ]]; then
        if [ "${options.rejectUpdateRequest ? 1 : 0}" -eq 1 ]; then return 2; fi
        if [ "${options.retryUpdateRequest ? 1 : 0}" -eq 1 ] && [ ! -e "${logPath}.update-attempted" ]; then
          touch "${logPath}.update-attempted"
          return 75
        fi
        touch "${logPath}.update-accepted"
        return 0
      fi
      if [[ "$*" == *3001/status* ]]; then
        if [ "${options.retryUpdateRequest ? 1 : 0}" -eq 1 ] && [ ! -e "${logPath}.update-accepted" ]; then
          printf 'failed\\nSaved app failed to start\\n\\n\\n\\n\\nOld app exited\\n'
          return
        fi
        if [ "${options.pendingHealth ? 1 : 0}" -eq 1 ] && [ ! -e "${logPath}.checked" ]; then
          touch "${logPath}.checked"
          printf 'starting\\nAn activity the installer has never heard of\\n42\\n'
          return
        fi
        printf '${options.appFails ? 'failed\\nApp health failed\\n\\n\\n\\n\\nApp exited' : 'ready\\nAgentsInTheCloud is ready\\n\\nhttps://app.example/custom-path\\n\\n\\n'}\\n'
        return
      fi ;;
    'logs --tail') echo 'supervisor startup failed: io.weight unavailable';;
    'inspect --format') if [[ "$*" == *'range $port'* ]]; then printf '%s\\n' ${JSON.stringify(options.adminMappings ?? '')}; elif [[ "$*" == *State.Status* ]]; then echo ${options.systemState ?? 'running'}; elif [[ "$*" == *3080/tcp* ]]; then echo 55123; else echo ${options.initiallyStopped ? "false" : "true"}; fi ;;
  esac
}
`;
  const script = installer
    .replace("tee /etc/modules-load.d/agents-in-the-cloud-system.conf", "tee /dev/null")
    // Mock terminal availability and answers; these tests exercise Docker orchestration.
    .replace('{ [ -t 0 ]; } 2>/dev/null <"$prompt_input"', "true")
    .replace(
      'IFS= read -r -t 120 "$1" <"$prompt_input"',
      `if [ "$1" = action ]; then action=update; else answer=${JSON.stringify(options.uninstallAnswer ?? (options.installed ? "yes" : "1"))}; fi`,
    );
  const result = Bun.spawnSync([process.platform === "darwin" ? "/bin/bash" : "bash", "-c", mock + script, "installer", ...args], { stdin: "ignore" });
  const log = Bun.spawnSync(["cat", logPath]).stdout.toString();
  Bun.spawnSync(["rm", "-f", logPath, `${logPath}.checked`, `${logPath}.update-attempted`, `${logPath}.update-accepted`, `${logPath}.container-removed`, `${logPath}.volume-removed`]);
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() + log };
}

test("piped sudo installs read prompts from the caller's terminal", () => {
  expect(installer).toContain('prompt_input="${SUDO_TTY:-/dev/tty}"');
  expect(installer).toContain('IFS= read -r -t 120 "$1" <"$prompt_input"');
});

test("fresh install launches privileged System with persistent named volume and bootstrap app", () => {
  const result = run({}, ["--system-image", "test/system:v1", "--app-image", "test/app:v1"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER pull test/system:v1");
  expect(result.output).toContain("--name agents-in-the-cloud-system --hostname agents-in-the-cloud-system --privileged --cgroupns=host --restart unless-stopped --stop-timeout 120 --tmpfs /run --mount source=agents-in-the-cloud-system,target=/data --publish 127.0.0.1:3080:3080 test/system:v1 --app-image test/app:v1 --access-mode tailscale");
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).toContain("DOCKER exec agents-in-the-cloud-system bun -e");
});

test("localhost install publishes a stable loopback port", () => {
  const result = run({}, ["--access-mode", "localhost"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 127.0.0.1:3080:3080");
  expect(result.output).toContain("--access-mode localhost");
  expect(result.output).not.toContain("--publish 127.0.0.1::3080");
});

test("replacement downloads before stopping and retains volume", () => {
  const result = run({ installed: true });
  expect(result.status).toBe(0);
  const commands = result.output;
  expect(commands.indexOf("DOCKER pull")).toBeLessThan(commands.indexOf("DOCKER stop --time 120 agents-in-the-cloud-system"));
  expect(commands.indexOf("DOCKER stop")).toBeLessThan(commands.indexOf("DOCKER rm agents-in-the-cloud-system"));
  expect(commands).toContain("--mount source=agents-in-the-cloud-system,target=/data");
  expect(commands).not.toContain("volume rm");
});

test("failed pull leaves existing System untouched", () => {
  const result = run({ installed: true, pullFails: true });
  expect(result.status).not.toBe(0);
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER run");
});

test("connect enables Tailscale on a running localhost installation without replacing or restarting System", () => {
  const result = run({ installed: true }, ["--action", "connect"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER exec agents-in-the-cloud-system bun -e");
  expect(result.output).toContain("http://127.0.0.1:3001/access");
  expect(result.output).toContain(" 55123 tailscale");
  expect(result.output).toContain("http://127.0.0.1:3001/connect");
  expect(result.output.indexOf("3001/access")).toBeLessThan(result.output.indexOf("3001/connect"));
  for (const command of ["pull", "stop", "rm", "run", "start", "restart"]) {
    expect(result.output).not.toContain(`DOCKER ${command}`);
  }
});

test("connect starts a stopped System before configuring Tailscale access", () => {
  const result = run({ installed: true, initiallyStopped: true }, ["--action", "connect"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER start agents-in-the-cloud-system");
  expect(result.output).toContain(" 55123 tailscale");
  expect(result.output.indexOf("DOCKER start")).toBeLessThan(result.output.indexOf("3001/access"));
  for (const command of ["pull", "stop", "rm", "run"]) {
    expect(result.output).not.toContain(`DOCKER ${command}`);
  }
});

test("connect honors an explicit localhost access mode", () => {
  const result = run({ installed: true }, ["--action", "connect", "--access-mode", "localhost"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("http://127.0.0.1:3001/access");
  expect(result.output).toContain(" 55123 localhost");
  expect(result.output).not.toContain(" 55123 tailscale");
  expect(result.output).not.toContain("3001/connect");
});

test("open honors an explicit Tailscale access mode without replacing System", () => {
  const result = run({ installed: true }, ["--action", "open", "--access-mode", "tailscale"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER exec agents-in-the-cloud-system bun -e");
  expect(result.output).toContain("http://127.0.0.1:3001/access");
  expect(result.output).toContain(" 55123 tailscale");
  expect(result.output).not.toContain("3001/connect");
  for (const command of ["pull", "stop", "rm", "run", "start", "restart"]) {
    expect(result.output).not.toContain(`DOCKER ${command}`);
  }
});

test("old installation is rejected without migration", () => {
  const result = run({ old: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("does not migrate");
  expect(result.output).not.toContain("DOCKER pull");
});

test("invalid action is rejected before Docker changes", () => {
  const result = run({}, ["--action", "destroy"]);
  expect(result.status).not.toBe(0);
  expect(result.output).not.toContain("DOCKER");
});


test("missing filesystem driver fails before image pull or System replacement", () => {
  const result = run({ installed: true, missingFilesystem: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("does not have erofs, which AgentsInTheCloud requires");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("DOCKER stop");
});


test("loads an available filesystem module before starting System", () => {
  const result = run({ missingFilesystem: true, loadable: true });
  expect(result.status).toBe(0);
  expect(result.output).toContain("MODPROBE erofs");
  expect(result.output.indexOf("MODPROBE erofs")).toBeLessThan(result.output.indexOf("DOCKER pull"));
});

test("supervisor failure stops System without removing its container or data", () => {
  const result = run({ appFails: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("3001/status");
  expect(result.output).toContain("DOCKER stop --time 120 agents-in-the-cloud-system");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("volume rm");
});

test("waits for supervisor readiness without interpreting the activity description", () => {
  const result = run({ pendingHealth: true });
  expect(result.status).toBe(0);
  expect(result.output.match(/http:\/\/127\.0\.0\.1:3001\/status/g)?.length).toBe(2);
});


test("macOS starts System directly without a temporary check container or host module changes", () => {
  const result = run({ mac: true, missingFilesystem: true });
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("DOCKER run --rm");
  expect(result.output).not.toContain("MODPROBE");
  expect(result.output).toContain("Open https://app.example/custom-path");
});


test("desktop defaults local while an explicit access choice overrides the OS", () => {
  const mac = run({ mac: true });
  expect(mac.status).toBe(0);
  expect(mac.output).toContain("--access-mode localhost");
  const wsl = run({ wsl: true });
  expect(wsl.status).toBe(0);
  expect(wsl.output).toContain("--access-mode localhost");
  const remote = run({ mac: true }, ["--access-mode", "tailscale"]);
  expect(remote.status).toBe(0);
  expect(remote.output).toContain("--access-mode tailscale");
});


test("open without an access choice preserves the existing access mode", () => {
  const result = run({ installed: true }, ["--action", "open"]);
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("3080/tcp");
  expect(result.output).not.toContain("3001/access");
  expect(result.output).not.toContain("3001/connect");
  expect(result.output).not.toContain("DOCKER stop");
});


test("Linux requests sudo itself while Mac and WSL with Docker access do not", () => {
  const linux = run({ nonRoot: true });
  expect(linux.status).toBe(0);
  expect(linux.output).toContain("SUDO -v");
  expect(linux.output).toContain("SUDO mkdir -p /etc/modules-load.d");
  for (const options of [{ mac: true }, { wsl: true, nonRoot: true }, {}]) {
    expect(run(options).output).not.toContain("SUDO");
  }
});

test("denied sudo fails before changing the Linux host", () => {
  const result = run({ nonRoot: true, denySudo: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("administrator access was not granted");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("MODPROBE");
});

for (const state of ["restarting", "exited"] as const) {
  for (const action of ["update", "open"] as const) {
    test(`${action} stops waiting and shows container logs when System is ${state}`, () => {
      const result = run({ installed: true, systemState: state }, ["--action", action]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`AgentsInTheCloud services are ${state}`);
      expect(result.output).toContain("supervisor startup failed: io.weight unavailable");
      expect(result.output).not.toContain("Waiting for the supervisor");
      expect(result.output).not.toContain("http://127.0.0.1:3001/status");
    });
  }
}

for (const action of ["open", "connect"]) {
  test(`${action} stops an existing System when its status reports failure`, () => {
    const result = run({ installed: true, appFails: true }, ["--action", action]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("DOCKER stop --time 120 agents-in-the-cloud-system");
    expect(result.output).not.toContain("DOCKER rm");
  });
}


test("update requests a channel update before accepting a healthy saved app", () => {
  const result = run({ installed: true }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output.indexOf("3001/access")).toBeLessThan(result.output.indexOf("3001/update-channel"));
  expect(result.output.indexOf("3001/update-channel")).toBeLessThan(result.output.indexOf("3001/status"));
});

test("update retries an unavailable supervisor even when the saved app failed", () => {
  const result = run({ installed: true, retryUpdateRequest: true }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output.match(/http:\/\/127\.0\.0\.1:3001\/update-channel/g)?.length).toBe(2);
  expect(result.output).toContain("Open https://app.example/custom-path");
});

test("update fails explicitly when the supervisor rejects the update request", () => {
  const result = run({ installed: true, rejectUpdateRequest: true }, ["--action", "update"]);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Could not request the AgentsInTheCloud app update");
  expect(result.output).not.toContain("Open https://");
});

for (const action of ["install", "open", "connect"]) {
  test(`${action} does not request an app channel update`, () => {
    const result = run({ installed: action !== "install" }, ["--action", action]);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("3001/update-channel");
  });
}

test("--uninstall cannot be combined with an install/update action", () => {
  const result = run({ installed: true }, ["--uninstall", "--action", "update"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("--uninstall cannot be combined with --action");
  expect(result.output).not.toContain("DOCKER pull");
});

test("uninstall cancellation warns with the exact inventory and deletes nothing", () => {
  const result = run({ installed: true, uninstallAnswer: "no" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("8 workspaces will be permanently deleted, including parked workspaces");
  expect(result.output).toContain("shared /persistent files, projects, settings, and locally saved credentials");
  expect(result.output).toContain("Uninstall cancelled. No data was deleted");
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER volume rm");
  expect(result.output).not.toContain("method:\"POST\"");
  expect(result.output).not.toContain("MODPROBE");
});

test("confirmed uninstall delegates cleanup, polls status, then removes only System and its volume", () => {
  const result = run({ installed: true, uninstallAnswer: "DELETE AGENTSINTHECLOUD" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Uninstalled. System and all installation data have been removed");
  expect(result.output).toContain("DOCKER exec --user root agents-in-the-cloud-system");
  expect(result.output).toContain("/run/agents-in-the-cloud-system/uninstall.sock");
  expect(result.output).toContain("DOCKER stop --time 120 agents-in-the-cloud-system");
  expect(result.output).toContain("DOCKER rm agents-in-the-cloud-system");
  expect(result.output).toContain("DOCKER volume rm agents-in-the-cloud-system");
  // Background run_quiet commands are captured in the log after foreground output.
  expect(result.output.indexOf("http://supervisor/uninstall")).toBeLessThan(result.output.indexOf("DOCKER stop --time 120"));
  expect(result.output).not.toContain("DOCKER system prune");
  expect(result.output).not.toContain("DOCKER pull");
});

for (const option of ["uninstallFails", "uninstallRequestFails", "inventoryFails"] as const) {
  test(`${option} retains the outer System container and volume`, () => {
    const result = run({ installed: true, uninstallAnswer: "DELETE AGENTSINTHECLOUD", [option]: true }, ["--uninstall"]);
    expect(result.status).toBe(1);
    expect(result.output).not.toContain("DOCKER stop");
    expect(result.output).not.toContain("DOCKER rm");
    expect(result.output).not.toContain("DOCKER volume rm");
  });
}

test("uninstall restarts a stopped supervisor to obtain its inventory, without downloading anything", () => {
  const result = run({ installed: true, initiallyStopped: true, uninstallAnswer: "no" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER start agents-in-the-cloud-system");
  expect(result.output).toContain("8 workspaces");
  expect(result.output).not.toContain("DOCKER pull");
});

test("uninstall can finish volume removal after System was already removed, with explicit unknown-count warning", () => {
  const result = run({ volumeOnly: true, uninstallAnswer: "DELETE AGENTSINTHECLOUD" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Workspace count unavailable");
  expect(result.output).not.toContain("0 workspaces");
  expect(result.output).toContain("DOCKER volume rm agents-in-the-cloud-system");
  expect(result.output).not.toContain("DOCKER exec");
});

test("uninstall does not claim success if installation volume removal fails", () => {
  const result = run({ volumeOnly: true, volumeRemovalFails: true, uninstallAnswer: "DELETE AGENTSINTHECLOUD" }, ["--uninstall"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Deleting installation storage failed");
  expect(result.output).not.toContain("Uninstalled. System");
});

test("uninstall is a no-op when no System container or volume remains", () => {
  const result = run({}, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Nothing to uninstall");
  expect(result.output).not.toContain("DOCKER run");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("Type DELETE AGENTSINTHECLOUD");
});


test("installer refuses Atelier without adopting or deleting its resources", () => {
  const result = run({ legacyAtelier: true }, ["--action", "install"]);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Run this installer with --uninstall first");
  expect(result.output).not.toContain("DOCKER run");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER volume rm");
});

test("uninstall delegates Atelier System cleanup to the frozen legacy installer", () => {
  const result = run({ legacyAtelier: true }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DELETE ATELIER");
  expect(result.output).toContain("CURL -fsSL https://raw.githubusercontent.com/lucasmeijer/atelier/34cea8ec/scripts/install.sh -o");
  expect(result.output).toMatch(/LEGACY BASH .*\.legacy --uninstall/);
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER pull");
});

test("legacy uninstaller download failure is explicit and never invokes cleanup", () => {
  const result = run({ legacyAtelier: true, legacyDownloadFails: true }, ["--uninstall"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Could not download the legacy Atelier uninstaller. Nothing has been deleted");
  expect(result.output).not.toContain("LEGACY BASH");
  expect(result.output).not.toContain("DOCKER rm");
});

test("legacy uninstaller failure propagates without removing resources itself", () => {
  const result = run({ legacyAtelier: true, legacyDelegateFails: true }, ["--uninstall"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("LEGACY BASH");
  expect(result.output).not.toContain("DOCKER rm");
});

test("when both products exist, uninstall removes only the new product and explains the next step", () => {
  const result = run({ installed: true, legacyAtelier: true, uninstallAnswer: "DELETE AGENTSINTHECLOUD" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Atelier will remain; run --uninstall again to inspect it");
  expect(result.output).toContain("DOCKER rm agents-in-the-cloud-system");
  expect(result.output).not.toContain("LEGACY BASH");
  expect(result.output).not.toContain("DOCKER rm atelier");
});

test("a remaining new-product volume takes precedence over legacy delegation", () => {
  const result = run({ volumeOnly: true, legacyAtelier: true, uninstallAnswer: "DELETE AGENTSINTHECLOUD" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER volume rm agents-in-the-cloud-system");
  expect(result.output).not.toContain("LEGACY BASH");
});

test("pre-System Atelier uninstall fails explicitly rather than claiming nothing is installed", () => {
  const result = run({ legacyPreSystem: true }, ["--uninstall"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Automatic uninstall is not supported for that layout");
  expect(result.output).not.toContain("Nothing to uninstall");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("LEGACY BASH");
});

test("fresh installer uses latest in the separate renamed repositories", () => {
  const result = run({});
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER pull ghcr.io/lucasmeijer/agents-in-the-cloud-system:latest");
  expect(result.output).toContain("--app-image ghcr.io/lucasmeijer/agents-in-the-cloud:latest");
  expect(result.output).not.toContain(":beta");
});

test("legacy installation storage remaining after container removal still delegates to Atelier cleanup", () => {
  const result = run({ legacyVolumeOnly: true }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("LEGACY BASH");
  expect(result.output).toContain("DELETE ATELIER");
  expect(result.output).not.toContain("Nothing to uninstall");
});

test("admin publication is explicit and does not replace local ingress", () => {
  const result = run({}, ["--action", "install", "--admin-publish", "192.168.1.10:3443:3443"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 127.0.0.1:3080:3080 --publish 192.168.1.10:3443:3443");
});
test("loopback admin publication and multiple ports are supported", () => {
  const result = run({}, ["--action", "install", "--admin-publish", "127.0.0.1:3443:3443", "--admin-publish", "192.168.1.10:3444:3444"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 127.0.0.1:3443:3443 --publish 192.168.1.10:3444:3444");
});
test("invalid admin publication cannot expose internal UI, supervisor or previews", () => {
  for (const mapping of ["3443", "localhost:3443:3443", "192.168.1.10:3443:3000", "192.168.1.10:3443:3001", "192.168.1.10:3443:3080", "192.168.1.10:3443:41001", "999.1.1.1:3443:3443"]) {
    const result = run({}, ["--action", "install", "--admin-publish", mapping]);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("DOCKER run");
  }
});
test("updates retain previously published admin ports", () => {
  const result = run({ installed: true, adminMappings: "192.168.1.10:3443:3443/tcp" }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 192.168.1.10:3443:3443");
});

test("admin publication removal skips saved mappings on update", () => {
  const result = run({ installed: true, adminMappings: "192.168.1.10:3443:3443/tcp" }, ["--action", "update", "--no-admin-publish"]);
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("--publish 192.168.1.10:3443:3443");
});
test("publication persistence reads Docker HostConfig, including stopped System", () => {
  expect(installer).toContain(".HostConfig.PortBindings");
  expect(installer).not.toContain(".NetworkSettings.Ports");
  const result = run({ installed: true, initiallyStopped: true, adminMappings: "192.168.1.10:3443:3443/tcp" }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 192.168.1.10:3443:3443");
});
test("publication flags cannot be silently ignored on open or connect", () => {
  for (const action of ["open", "connect"]) {
    const result = run({ installed: true }, ["--action", action, "--admin-publish", "127.0.0.1:3443:3443"]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("require --action install or update");
  }
});
test("wildcard publication requires explicit informed opt-in", () => {
  const denied = run({}, ["--action", "install", "--admin-publish", "0.0.0.0:3443:3443"]);
  expect(denied.status).not.toBe(0);
  const allowed = run({}, ["--action", "install", "--admin-publish", "0.0.0.0:3443:3443", "--allow-admin-all-interfaces"]);
  expect(allowed.status).toBe(0);
  expect(allowed.output).toContain("Docker publication may bypass host firewall");
});
test("publication removal and replacement are mutually exclusive", () => {
  expect(run({}, ["--action", "install", "--admin-publish", "127.0.0.1:3443:3443", "--no-admin-publish"]).status).not.toBe(0);
});
