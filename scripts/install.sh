#!/usr/bin/env bash
set -Eeuo pipefail

system_image=ghcr.io/lucasmeijer/agents-in-the-cloud-system:latest
app_image=ghcr.io/lucasmeijer/agents-in-the-cloud:latest
source_repository=""
tailscale_hostname=""
registry_config=""
registry_directory=""
app_image_override=""
system_image_override=""
pinned_app=""
old_system_image=""
action=""
uninstall_requested=0
access_mode=""
system_name=agents-in-the-cloud-system

# Keep subprocess output available without turning the welcome into a log tail.
log_file=""
legacy_installer=""
interactive=0
violet="" cyan="" green="" amber="" dim="" reset=""
if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
  interactive=1
  violet=$'\033[35m' cyan=$'\033[36m' green=$'\033[32m'
  amber=$'\033[33m' dim=$'\033[2m' reset=$'\033[0m'
fi
last_status=""
spinner_frame=0
active_pid=""
stop_on_failure=0

finish_line() {
  if [ "$interactive" -eq 1 ] && [ -n "$last_status" ]; then printf '\r\033[2K'; fi
  last_status=""
}
status() {
  local text="$1" elapsed="${2:-}" percent="${3:-}" bar="" i suffix
  local rows columns available
  local frames="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  local frame="${frames:spinner_frame:1}"
  spinner_frame=$(((spinner_frame + 1) % 10))
  if [ -n "$percent" ]; then
    for ((i=0; i<10; i++)); do
      if [ "$i" -lt "$((percent/10))" ]; then bar+="━"; else bar+="─"; fi
    done
    suffix="$bar $percent%"
  elif [[ "$text" == *" · "*" layers ready" ]]; then
    suffix="${text##* · }  $elapsed"
    text="${text% · *}"
  else
    suffix="$elapsed"
  fi
  if [ "$interactive" -eq 1 ]; then
    read -r rows columns < <(stty size </dev/tty)
    available=$((columns - 8 - ${#suffix}))
    if [ "$available" -lt 10 ]; then available=10; fi
    if [ "${#text}" -gt "$available" ]; then text="${text:0:available-1}…"; fi
    printf '\r\033[2K  %s%s %s%s  %s%s%s' "$cyan" "$frame" "$text" "$reset" "$dim" "$suffix" "$reset"
  elif [ "$1" != "$last_status" ]; then
    printf '  %s\n' "$text"
  fi
  last_status="$1"
}
fail() {
  finish_line
  printf '\n  %s! %s%s\n' "$amber" "$*" "$reset" >&2
  exit 1
}
prompt() {
  printf '%s' "$2"
  IFS= read -r -t 120 "$1" <"$prompt_input" || fail "No response received within 2 minutes, or terminal input closed. Run the installer again when ready."
}
# Runs a step with a progress line and returns its exit status.
run_quiet_status() {
  local label="$1" pid start=$SECONDS code=0
  shift
  "$@" <&0 >>"$log_file" 2>&1 &
  pid=$!
  active_pid=$pid
  while kill -0 "$pid" 2>/dev/null; do
    status "$label" "$((SECONDS-start))s"
    if [ "$((SECONDS-start))" -ge 1800 ]; then
      kill "$pid"
      wait "$pid" || :
      active_pid=""
      fail "Timed out: $label."
    fi
    sleep 0.1
  done
  active_pid=""
  wait "$pid" || code=$?
  return "$code"
}
run_quiet() {
  run_quiet_status "$@" || fail "$1 failed. See the bootstrap log for details."
}
cleanup() {
  local code=$?
  trap - ERR
  if [ -n "$legacy_installer" ]; then rm -f "$legacy_installer"; fi
  finish_line
  if [ -n "$active_pid" ] && kill -0 "$active_pid" 2>/dev/null; then
    kill "$active_pid"
    wait "$active_pid" || :
  fi
  if [ -n "$registry_directory" ]; then rm -rf "$registry_directory"; fi
  if [ "$code" -ne 0 ] && [ "$stop_on_failure" -eq 1 ]; then
    printf '\n  Stopping AgentsInTheCloud services after installation failure.\n' >&2
    if ! docker stop --time 120 "$system_name" >>"$log_file" 2>&1; then
      printf '  Could not stop AgentsInTheCloud services. Run: docker stop %s\n' "$system_name" >&2
    fi
    printf '  Local diagnostics: docker logs %s\n' "$system_name" >&2
  fi
  if [ "$code" -ne 0 ] && [ -n "$log_file" ]; then
    printf '  Bootstrap log: %s\n' "$log_file" >&2
  fi
}
trap cleanup EXIT
trap 'fail "Installation could not continue. See the bootstrap log for details."' ERR
trap 'fail "Installation interrupted."' INT TERM

usage() {
  cat <<'HELP'
Usage: install.sh [options]

Installs AgentsInTheCloud System, or offers actions for an existing installation.
System replacements preserve the agents-in-the-cloud-system volume and interrupt workspaces.
Update also installs the newest AgentsInTheCloud app on the installation's selected channel.

  --system-image REF   Explicit System selection (otherwise the saved release source)
  --app-image REF      Explicit app selection, including on existing installations
  --source-repository REPO  App repository (GHCR or Docker Hub); System defaults to REPO-system
  --tailscale-hostname NAME  Tailscale machine name (prompted on setup)
  --registry-config FILE  Docker config with inline GHCR auth; copied privately into System
  --access-mode MODE  localhost or tailscale (default selected for this machine)
  --action ACTION     install, update, rollback, connect, or open
                      connect enables Tailscale without replacing an existing installation
  --uninstall         Permanently delete installation data (also supports Atelier System)
  -h, --help          Show help

Setup prompts for a release repository and a Tailscale hostname. Updates retain saved selections.
Registry-qualified image overrides are persisted; local image overrides are one-off selections.
There is no migration from the previous AgentsInTheCloud installation layout.
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --system-image|--app-image|--action|--access-mode|--source-repository|--tailscale-hostname|--registry-config)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$1" in
        --system-image) system_image="$2"; system_image_override="$2" ;;
        --app-image) app_image="$2"; app_image_override="$2" ;;
        --source-repository) source_repository="$2" ;;
        --tailscale-hostname) tailscale_hostname="$2" ;;
        --registry-config) registry_config="$2" ;;
        --action) action="$2" ;;
        --access-mode) access_mode="$2" ;;
      esac
      shift 2 ;;
    --uninstall) uninstall_requested=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
if [ "$uninstall_requested" -eq 1 ]; then
  [ -z "$action" ] || fail "--uninstall cannot be combined with --action"
  action=uninstall
fi
case "$action" in ""|install|update|rollback|connect|open|uninstall) ;; *) fail "unknown action: $action" ;; esac
case "$access_mode" in ""|localhost|tailscale) ;; *) fail "unknown access mode: $access_mode" ;; esac
for reference in "$app_image_override" "$system_image_override"; do
  [ -z "$reference" ] || [[ "$reference" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$ ]] || fail "Invalid explicit image reference"
done
# stdin may carry the script itself (curl | bash). With sudo's use_pty option,
# /dev/tty is sudo's relay PTY and receives no input when sudo itself was piped.
# SUDO_TTY names the caller's terminal, which remains available for prompts.
prompt_input="${SUDO_TTY:-/dev/tty}"
{ [ -t 0 ]; } 2>/dev/null <"$prompt_input" ||
  fail "Interactive setup requires a terminal. Run this installer from a terminal (piping to bash is supported)."

host_os="$(uname -s)"
desktop=0
if [ "$host_os" = Darwin ] || { [ "$host_os" = Linux ] && grep -qi microsoft /proc/sys/kernel/osrelease; }; then desktop=1; fi
case "$host_os" in
  Linux) ;;
  Darwin)
    # Docker Desktop belongs to the logged-in user, including when the installer
    # was invoked with sudo. Keep that user's Docker context and credentials.
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
      docker_binary="$(command -v docker)" || fail "install and start Docker Desktop first"
      docker() { sudo -H -u "$SUDO_USER" "$docker_binary" "$@"; }
    fi ;;
  *) fail "AgentsInTheCloud System requires Linux or macOS with Docker Desktop" ;;
esac

root_required=0
docker_via_sudo=0
request_root() {
  if [ "$(id -u)" -ne 0 ] && [ "$root_required" -eq 0 ]; then
    command -v sudo >/dev/null || fail "sudo is required for Linux host setup; install sudo or run as root"
    finish_line
    printf '  AgentsInTheCloud needs administrator access to prepare this Linux host.\n'
    sudo -v || fail "administrator access was not granted"
    root_required=1
  fi
}

run_root() {
  if [ "$root_required" -eq 1 ]; then sudo "$@"; else "$@"; fi
}

log_file="$(mktemp /tmp/agents-in-the-cloud-install.XXXXXX)"
printf "\n  %sLet's get your AgentsInTheCloud setup!%s\n\n" "$violet" "$reset"
status "Preparing your server"
if ! command -v docker >/dev/null; then
  [ "$action" != uninstall ] || fail "Docker is not installed; no installation can be inspected or removed"
  [ "$host_os" != Darwin ] || fail "install and start Docker Desktop first, then run this installer again"
  request_root
  if command -v apt-get >/dev/null; then
    run_quiet "Preparing your server · installing Docker" run_root apt-get update
    run_quiet "Preparing your server · installing Docker" run_root apt-get install -y docker.io
  elif command -v dnf >/dev/null; then
    run_quiet "Preparing your server · installing Docker" run_root dnf install -y docker
  else
    fail "install Docker first; automatic Docker installation supports apt-get and dnf"
  fi
  run_quiet "Starting Docker" run_root systemctl enable --now docker
fi
if [ "$host_os" = Linux ] && [ "$(id -u)" -ne 0 ] && ! docker info >>"$log_file" 2>&1; then
  request_root
  docker_binary="$(command -v docker)"
  docker() { sudo "$docker_binary" "$@"; }
  docker_via_sudo=1
fi
run_quiet "Checking Docker" docker info

# Nested daemons share the host kernel; privileged containers cannot supply
# filesystem drivers missing from that kernel.
if [ "$action" != uninstall ] && [ "$host_os" = Linux ] && [ "$desktop" -eq 0 ]; then
  request_root
  for filesystem in erofs overlay; do
    if ! grep -qw "$filesystem" /proc/filesystems; then
      if ! command -v modprobe >/dev/null || ! run_root modprobe "$filesystem"; then
        fail "The Linux kernel that powers your Docker does not have $filesystem, which AgentsInTheCloud requires."
      fi
      grep -qw "$filesystem" /proc/filesystems || fail "The Linux kernel that powers your Docker does not have $filesystem, which AgentsInTheCloud requires."
    fi
  done
  run_root mkdir -p /etc/modules-load.d
  printf 'erofs\noverlay\n' | run_root tee /etc/modules-load.d/agents-in-the-cloud-system.conf >/dev/null
fi

installed=0
if docker container inspect "$system_name" >/dev/null 2>&1; then installed=1; fi
# Keep the legacy cleanup implementation frozen: it knows Atelier's names,
# socket, storage, inventory contract, and DELETE ATELIER confirmation.
if [ "$action" = uninstall ]; then
  new_volume="$(docker volume ls --format '{{.Name}}' --filter "name=^${system_name}$")"
  legacy_system=0
  if docker container inspect atelier-system >/dev/null 2>&1; then legacy_system=1; fi
  legacy_volume="$(docker volume ls --format '{{.Name}}' --filter 'name=^atelier-system$')"
  legacy_container=0
  if docker container inspect atelier >/dev/null 2>&1; then legacy_container=1; fi
  if [ "$installed" -eq 1 ] || [ -n "$new_volume" ]; then
    if [ "$legacy_system" -eq 1 ] || [ -n "$legacy_volume" ] || [ "$legacy_container" -eq 1 ]; then
      printf '\n  Removing AgentsInTheCloud only. Atelier will remain; run --uninstall again to inspect it.\n'
    fi
  elif [ "$legacy_system" -eq 1 ] || [ -n "$legacy_volume" ]; then
    finish_line
    printf '\n  Atelier System found. Its legacy uninstaller will count workspaces and ask you to type DELETE ATELIER.\n'
    printf '  Older System images may need an Atelier System update before uninstall is available. No update will be performed here.\n'
    legacy_installer="$(mktemp /tmp/atelier-legacy-uninstall.XXXXXX)"
    if ! curl -fsSL https://raw.githubusercontent.com/lucasmeijer/atelier/34cea8ec/scripts/install.sh -o "$legacy_installer"; then
      fail "Could not download the legacy Atelier uninstaller. Nothing has been deleted."
    fi
    legacy_code=0
    run_root bash "$legacy_installer" --uninstall || legacy_code=$?
    exit "$legacy_code"
  elif [ "$legacy_container" -eq 1 ]; then
    fail "The old atelier container predates Atelier System. Automatic uninstall is not supported for that layout; its container and data have been retained."
  fi
fi
if [ "$action" != uninstall ] && { docker container inspect atelier-system >/dev/null 2>&1 || docker container inspect atelier >/dev/null 2>&1; }; then
  fail "Atelier is installed. Run this installer with --uninstall first; AgentsInTheCloud starts fresh and does not import Atelier data."
fi
if [ "$installed" -eq 0 ] && docker container inspect agents-in-the-cloud >/dev/null 2>&1; then
  fail "an old AgentsInTheCloud container exists; this installer does not migrate old installations"
fi
if [ "$installed" -eq 0 ]; then
  case "$action" in
    uninstall) ;; # A previous removal may have left only the outer volume.
    ""|install|update) action=install ;;
    *) fail "AgentsInTheCloud System is not installed" ;;
  esac
elif [ "$action" = install ]; then
  fail "AgentsInTheCloud System is already installed; use --action update"
fi

# The supervisor owns app lifecycle and routing. Query locally so the host
# does not need tailnet access, curl, or a JSON parser.
supervisor_status() {
  docker exec "$system_name" bun -e '
    const r = await fetch("http://127.0.0.1:3001/status", {signal: AbortSignal.timeout(3000)});
    if (!r.ok) throw new Error(`Supervisor status: ${r.status}`);
    const clean = (text) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const url = (value) => {
      if (value === undefined) return "";
      if (typeof value !== "string" || !/^https?:$/.test(new URL(value).protocol) || /[\x00-\x20\x7f]/.test(value))
        throw new Error("Invalid System destination");
      return value;
    };
    try {
      const s = await r.json();
      const a = s.activity;
      if (!["starting", "ready", "failed"].includes(s.state) ||
          typeof a?.description !== "string" || !a.description.trim() ||
          (a.percent !== undefined && (typeof a.percent !== "number" ||
            !Number.isFinite(a.percent) || a.percent < 0 || a.percent > 100))) {
        throw new Error("Invalid supervisor status contract");
      }
      const appUrl = url(s.appUrl);
      if (s.state === "ready" && !appUrl) throw new Error("Ready without an app destination");
      console.log([
        s.state, clean(a.description), a.percent === undefined ? "" : Math.floor(a.percent),
        appUrl, clean(s.action?.description ?? ""), url(s.action?.url),
        ...(s.diagnostics?.lines ?? []).map(clean),
      ].join("\n"));
    } catch (error) {
      console.error(error);
      process.exit(2);
    }
  '
}
supervisor_connect() {
  docker exec "$system_name" bun -e '
    const r = await fetch("http://127.0.0.1:3001/connect", {
      method: "POST", signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`System connection request: ${r.status}`);
  '
}
check_system_running() {
  local state
  state="$(docker inspect --format '{{.State.Status}}' "$system_name" 2>>"$log_file")"
  if [ "$state" != running ]; then
    finish_line
    docker logs --tail 40 "$system_name" 2>&1 | tee -a "$log_file" >&2
    fail "AgentsInTheCloud services are $state. Container logs are shown above."
  fi
}
wait_for_system() {
  stop_on_failure=1
  local reply previous="" activity_start=$SECONDS start=$SECONDS description="Waiting for the supervisor" percent="" code pid status_file tick
  status_file="${log_file}.status"
  local request_connect=0 last_action="" current_action app_url
  local -a fields
  if [ "$action" = connect ] && [ "$access_mode" != localhost ]; then request_connect=1; fi
  while true; do
    check_system_running
    if [ "$request_connect" -eq 1 ]; then
      if supervisor_connect >>"$log_file" 2>&1; then request_connect=0; fi
    fi
    supervisor_status >"$status_file" 2>>"$log_file" &
    pid=$!
    active_pid=$pid
    while kill -0 "$pid" 2>/dev/null; do
      status "$description" "$((SECONDS-activity_start))s" "$percent"
      sleep 0.1
    done
    active_pid=""
    code=0
    wait "$pid" || code=$?
    reply="$(cat "$status_file")"
    if [ "$code" -eq 0 ]; then
      fields=()
      while IFS= read -r field; do fields+=("$field"); done <<<"$reply"
      description="${fields[1]}"
      percent="${fields[2]:-}"
      app_url="${fields[3]:-}"
      current_action="${fields[4]:-}"$'\n'"${fields[5]:-}"
      if [ "${fields[0]}" != failed ] && [ -n "${fields[4]:-}" ] && [ "$current_action" != "$last_action" ]; then
        finish_line
        printf '\n  %s\n' "${fields[4]}"
        [ -z "${fields[5]:-}" ] || printf '\n  %s\n\n' "${fields[5]}"
        last_action="$current_action"
      fi
      case "${fields[0]}" in
        ready) [ "$request_connect" -ne 0 ] || break ;;
        failed)
          finish_line
          printf '\n  %s! %s%s\n' "$amber" "$description" "$reset" >&2
          if [ "${#fields[@]}" -gt 6 ]; then printf '  %s\n' "${fields[@]:6}" >&2; fi
          exit 1 ;;
      esac
    else
      [ "$code" -ne 2 ] || fail "The supervisor returned an invalid status."
      description="Waiting for the supervisor"; percent=""
    fi
    if [ "${description%% · *}" != "$previous" ]; then activity_start=$SECONDS; previous="${description%% · *}"; fi
    status "$description" "$((SECONDS-activity_start))s" "$percent"
    [ "$((SECONDS-start))" -lt 2400 ] || fail "AgentsInTheCloud did not finish starting within 40 minutes."
    for ((tick=0; tick<10; tick++)); do
      status "$description" "$((SECONDS-activity_start))s" "$percent"
      sleep 0.1
    done
  done
  rm "$status_file"
  finish_line
  printf '  %s✓ %s%s\n\n  Open %s\n\n' "$green" "$description" "$reset" "$app_url"
}

uninstall_system() {
  local start=$SECONDS code reply token workspace_count state description remaining
  local -a fields
  if [ "$installed" -eq 1 ]; then
    if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
      run_quiet "Starting System to inspect the uninstall inventory" docker start "$system_name"
    fi
    while true; do
      check_system_running
      code=0
      reply="$(docker exec --user root "$system_name" bun -e '
        let response;
        try {
          response = await fetch("http://supervisor/uninstall", {unix:"/run/agents-in-the-cloud-system/uninstall.sock", signal:AbortSignal.timeout(3000)});
        } catch (error) { console.error(error); process.exit(75); }
        if (response.status === 503) process.exit(75);
        if (!response.ok) { console.error(await response.text()); process.exit(2); }
        const plan = await response.json();
        if (!Number.isSafeInteger(plan.workspaceCount) || plan.workspaceCount < 0 ||
            typeof plan.token !== "string" || !/^[a-f0-9]{64}$/.test(plan.token)) process.exit(2);
        console.log(`${plan.workspaceCount}\n${plan.token}`);
      ' 2>>"$log_file")" || code=$?
      case "$code" in
        0) break ;;
        75) ;;
        *) fail "Could not read workspace inventory. Nothing has been deleted. See the bootstrap log." ;;
      esac
      status "Waiting for System's uninstall inventory" "$((SECONDS-start))s"
      [ "$((SECONDS-start))" -lt 240 ] || fail "System's uninstall inventory is unavailable. Update System with --action update first. Nothing has been deleted."
      sleep 1
    done
    fields=()
    while IFS= read -r field; do fields+=("$field"); done <<<"$reply"
    workspace_count="${fields[0]}"; token="${fields[1]}"
    finish_line
    printf '\n  %s workspaces will be permanently deleted, including parked workspaces.\n' "$workspace_count"
  else
    remaining="$(docker volume ls --format '{{.Name}}' --filter "name=^${system_name}$")"
    if [ -z "$remaining" ]; then
      finish_line
      printf '\n  No installation container or volume remains. Nothing to uninstall.\n'
      return
    fi
    finish_line
    printf '\n  System was already removed, but its installation volume remains.\n  Workspace count unavailable: all remaining installation data will be deleted.\n'
  fi
  printf '\n  This also deletes workspace files, conversations, nested Docker data,\n  shared /persistent files, projects, settings, and locally saved credentials.\n  Nothing is imported into a new installation. Save anything you need first.\n\n'
  prompt answer "  Type DELETE AGENTSINTHECLOUD to confirm, or anything else to cancel: "
  if [ "$answer" != "DELETE AGENTSINTHECLOUD" ]; then
    printf '\n  Uninstall cancelled. No data was deleted.\n'
    return
  fi
  if [ "$installed" -eq 1 ]; then
    docker exec --user root "$system_name" bun -e '
      const response = await fetch("http://supervisor/uninstall", {
        unix:"/run/agents-in-the-cloud-system/uninstall.sock", method:"POST",
        headers:{"content-type":"application/json"}, body:JSON.stringify({token:process.argv[1]}),
        signal:AbortSignal.timeout(3000),
      });
      if (response.status !== 202) throw new Error(`Uninstall request: ${response.status} ${await response.text()}`);
    ' "$token" >>"$log_file" 2>&1 || fail "System did not accept uninstall. Its container and volume have not been removed."
    start=$SECONDS
    while true; do
      check_system_running
      reply="$(docker exec --user root "$system_name" bun -e '
        const response = await fetch("http://127.0.0.1:3001/status", {signal:AbortSignal.timeout(3000)});
        if (!response.ok) throw new Error(`Uninstall status: ${response.status}`);
        const {uninstall} = await response.json();
        if (!["running","failed","complete"].includes(uninstall?.state) || typeof uninstall.description !== "string")
          throw new Error("Invalid uninstall status contract");
        console.log(`${uninstall.state}\n${uninstall.description.replace(/[\x00-\x1f\x7f-\x9f]/g," ")}`);
      ' 2>>"$log_file")" || fail "Could not read uninstall status. System and its volume were retained; run --uninstall again."
      fields=()
      while IFS= read -r field; do fields+=("$field"); done <<<"$reply"
      state="${fields[0]}"; description="${fields[1]}"
      case "$state" in
        complete) break ;;
        failed) fail "Uninstall failed: $description System and its installation volume were retained; run --uninstall again." ;;
      esac
      status "$description" "$((SECONDS-start))s"
      [ "$((SECONDS-start))" -lt 2400 ] || fail "Uninstall did not finish within 40 minutes. System and its volume were retained."
      sleep 1
    done
    run_quiet "Stopping System" docker stop --time 120 "$system_name"
    run_quiet "Removing System" docker rm "$system_name"
  fi
  remaining="$(docker volume ls --format '{{.Name}}' --filter "name=^${system_name}$")"
  if [ -n "$remaining" ]; then run_quiet "Deleting installation storage" docker volume rm "$system_name"; fi
  remaining="$(docker ps -a --format '{{.Names}}' --filter "name=^${system_name}$")"
  [ -z "$remaining" ] || fail "System container still exists"
  remaining="$(docker volume ls --format '{{.Name}}' --filter "name=^${system_name}$")"
  [ -z "$remaining" ] || fail "Installation volume still exists"
  if [ "$host_os" = Linux ] && [ -f /etc/modules-load.d/agents-in-the-cloud-system.conf ]; then
    request_root
    run_root rm /etc/modules-load.d/agents-in-the-cloud-system.conf
  fi
  finish_line
  printf '\n  %s✓ Uninstalled. System and all installation data have been removed.%s\n  Docker and unrelated host resources were left installed.\n\n' "$green" "$reset"
}

if [ "$action" = uninstall ]; then
  uninstall_system
  exit 0
fi

if [ -z "$action" ]; then
  finish_line
  printf '  Welcome back.\n'
  prompt action "  Choose: open, update, rollback, connect, or quit: "
  [ "$action" != quit ] || exit 0
  case "$action" in connect|update|rollback|open) ;; *) fail "unknown action: $action" ;; esac
fi

if [ -n "$source_repository$tailscale_hostname$registry_config$app_image_override$system_image_override" ]; then
  case "$action" in install|update) ;; *) fail "Source, hostname, registry and image options require install or update" ;; esac
fi


# This portable Bun helper also runs in older System images, without app/module dependencies.
release_config_script="$(cat <<'INSTALLER_CONFIG_JS'
const [operation, sourceOverride, appOverride, systemOverride, hostnameOverride, systemId, preparedApp, credentialFile, previousSystemId] = process.argv.slice(1);
const fs = await import('node:fs/promises');
const repositoryPattern = /^(?:ghcr\.io|docker\.io)\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const versionPattern = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|sha256:[a-f0-9]{64})$/;
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
async function read(path) {
  try { const value = JSON.parse(await fs.readFile(path, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid installation settings'); return value; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw Error('Cannot read installation settings; refusing another source'); }
}
let settings = await read('/data/app/update.json');
const state = await read('/data/supervisor/state.json');
const history = await read('/data/supervisor/installer.json');
if (settings.releaseChannel !== undefined && !['stable','latest'].includes(settings.releaseChannel)) throw Error('Invalid release channel');
if (settings.releaseMode !== undefined && !['upstream','custom'].includes(settings.releaseMode)) throw Error('Invalid release mode');
function validSource(source) {
  return source && typeof source === 'object' && !Array.isArray(source) && typeof source.appRepository === 'string' && typeof source.systemRepository === 'string' && Object.keys(source).every(key => ['appRepository','systemRepository','appVersion','systemVersion'].includes(key)) && repositoryPattern.test(source.appRepository ?? '') && repositoryPattern.test(source.systemRepository ?? '') && ['appVersion','systemVersion'].every(key => source[key] === undefined || typeof source[key] === 'string' && versionPattern.test(source[key]));
}
if (settings.releaseSource !== undefined && !validSource(settings.releaseSource)) throw Error('Invalid release source; refusing upstream fallback');
if (settings.releaseMode === 'custom' && !settings.releaseSource) throw Error('Custom source is missing');
const defaults = {appRepository:'ghcr.io/lucasmeijer/agents-in-the-cloud',systemRepository:'ghcr.io/lucasmeijer/agents-in-the-cloud-system'};
if (sourceOverride) {
  if (!repositoryPattern.test(sourceOverride)) throw Error('Use a GHCR or Docker Hub app repository');
  settings.releaseSource = {appRepository:sourceOverride,systemRepository:sourceOverride+'-system'};
  settings.releaseMode = sourceOverride === defaults.appRepository ? 'upstream' : 'custom';
}
const overrides = {app:appOverride,system:systemOverride};
for (const [component, reference] of Object.entries(overrides)) {
  if (!reference) continue;
  if (!imagePattern.test(reference)) throw Error('Invalid explicit image reference');
  if (!/^(ghcr\.io|docker\.io)\//.test(reference)) continue; // Local overrides are deliberate one-off selections.
  const match = /^((?:ghcr\.io|docker\.io)\/[a-z0-9._/-]+)(?::([^/@]+)|@(sha256:[a-f0-9]{64}))?$/.exec(reference);
  if (!match) throw Error('Invalid release image override');
  const source = {...(settings.releaseMode === 'upstream' ? defaults : settings.releaseSource ?? defaults)};
  source[component+'Repository'] = match[1];
  if (match[3] || match[2]) source[component+'Version'] = match[3] || match[2]; else delete source[component+'Version'];
  if (!validSource(source)) throw Error('Invalid release image override');
  settings.releaseSource = source; settings.releaseMode = 'custom';
}
const source = settings.releaseMode === 'upstream' ? defaults : settings.releaseSource ?? defaults;
function reference(component) {
  if (overrides[component]) return overrides[component];
  const version = source[component+'Version'] ?? settings.releaseChannel ?? 'latest';
  return source[component+'Repository']+(version.startsWith('sha256:')?'@':':')+version;
}
const hostname = hostnameOverride || state.tailscaleHostname || 'agents-in-the-cloud-system';
if (typeof hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw Error('Use a Tailscale hostname with 1–63 lowercase letters, digits or hyphens');
let registryAuth;
if (credentialFile) {
  let credentials;
  if (credentialFile === '-') {
    try { credentials = JSON.parse(await new Response(Bun.stdin.stream()).text()); }
    catch { throw Error('Cannot read registry credentials'); }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw Error('Invalid registry credentials');
  } else credentials = await read(credentialFile);
  registryAuth = credentials.auths?.['ghcr.io']?.auth;
  if (Object.keys(credentials).some(key => key !== 'auths') || typeof registryAuth !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(registryAuth)) throw Error('Registry config must contain inline GHCR auth only, without credential helpers');
}
async function write(path,value,owner) {
  const temporary = path+'.installer-'+crypto.randomUUID();
  await fs.writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});
  if (owner) await fs.chown(temporary,1000,1000);
  await fs.rename(temporary,path);
}
async function writeAuth() {
  await fs.mkdir('/data/supervisor/docker-auth',{recursive:true,mode:0o700}); await fs.chmod('/data/supervisor/docker-auth',0o700);
  await write('/data/supervisor/docker-auth/config.json',{auths:{'ghcr.io':{auth:registryAuth}}},false);
}
if (operation === 'auth-check') {
  const credentials = await read('/data/supervisor/docker-auth/config.json');
  if (credentials.auths?.['ghcr.io']?.auth !== undefined && (typeof credentials.auths['ghcr.io'].auth !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(credentials.auths['ghcr.io'].auth))) throw Error('Invalid saved registry auth');
  console.log(credentials.auths?.['ghcr.io']?.auth ? '1' : '0');
} else if (operation === 'credentials') {
  if (!registryAuth) throw Error('Registry auth is required');
  await writeAuth();
} else if (operation === 'rollback-plan') {
  if (!imageIdPattern.test(history.previousSystemImage ?? '') || !imageIdPattern.test(history.previousAppImage ?? '')) throw Error('No retained System/app rollback pair');
  console.log([history.previousSystemImage,history.previousAppImage,hostname].join('\n'));
} else if (operation === 'plan') {
  console.log([reference('system'),reference('app'),hostname].join('\n'));
} else if (operation === 'apply' || operation === 'rollback-apply') {
  if (!imageIdPattern.test(systemId)) throw Error('System must be pinned before replacement');
  if (preparedApp && !imageIdPattern.test(preparedApp)) throw Error('App must be pinned before replacement');
  await fs.mkdir('/data/app', {recursive:true}); await fs.mkdir('/data/supervisor', {recursive:true});
  await write('/data/app/update.json',settings,true);
  state.tailscaleHostname = hostname;
  const previousAppImage = state.currentImage ?? null;
  if (operation === 'rollback-apply') {
    state.previousImage = state.currentImage;
    state.currentImage = preparedApp;
    delete state.pendingImage;
  } else if (preparedApp) state.pendingImage = preparedApp;
  await write('/data/supervisor/state.json',state,false);
  await write('/data/supervisor/installer.json',{currentSystemImage:systemId,previousSystemImage:previousSystemId || history.currentSystemImage || null,previousAppImage},false);
  if (registryAuth) await writeAuth();
} else throw Error('Unknown installer configuration operation');
INSTALLER_CONFIG_JS
)"
release_plan() {
  if [ -n "$registry_directory" ]; then
    docker run --rm -i --network none --entrypoint bun --mount "source=$system_name,target=/data,readonly" "$1" -e "$release_config_script" "${2:-plan}" "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "" "" - < "$registry_directory/config.json"
  else
    docker run --rm --network none --entrypoint bun --mount "source=$system_name,target=/data,readonly" "$1" -e "$release_config_script" "${2:-plan}" "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname"
  fi
}
host_pull() {
  if [ -n "$registry_directory" ]; then docker --config "$registry_directory" pull "$1"; else docker pull "$1"; fi
}
prepare_installed_app() {
  docker exec "$system_name" bun -e '
    const reference=process.argv[1];
    async function docker(...args) {
      const p=Bun.spawn(["docker","--config","/data/supervisor/docker-auth",...args],{stdout:"pipe",stderr:"pipe"});
      const deadline=setTimeout(()=>p.kill(),1800000);
      const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
      clearTimeout(deadline);
      if(code!==0)throw new Error("Cannot prepare the selected app or its dependencies; existing services were retained");
      return out.trim();
    }
    if(/^(ghcr\.io|docker\.io)\//.test(reference)) await docker("pull",reference);
    const image=JSON.parse(await docker("image","inspect",reference))[0];
    const dependencies=JSON.parse(image.Config.Labels?.["eagerly-preload"]??"[]");
    if(!Array.isArray(dependencies)||dependencies.length>100||dependencies.some(ref=>typeof ref!=="string"||! /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(ref)))throw new Error("Invalid workspace dependency references");
    for(const dependency of dependencies){
      if(/^(ghcr\.io|docker\.io)\//.test(dependency))await docker("pull",dependency);
      else await docker("image","inspect",dependency);
    }
    console.log(image.Id);
  ' "$app_image"
}

case "$action" in
  install|update|rollback)
    if [ "$installed" -eq 1 ]; then
      finish_line
      printf '  %sUpdating interrupts running workspaces.%s\n' "$amber" "$reset"
      prompt answer "  Continue? [y/N]: "
      case "$answer" in y|Y|yes) ;; *) exit 0 ;; esac
    fi
    if [ "$installed" -eq 0 ] && [ -z "$access_mode" ]; then
      if [ "$desktop" -eq 1 ]; then access_mode=localhost; else access_mode=tailscale; fi
      finish_line
      local_caption="Installation computer only — Tailscale stays off"
      remote_caption="Devices on your Tailscale network — including the installation computer"
      if [ "$access_mode" = localhost ]; then
        first_caption="$local_caption"; second_caption="$remote_caption"; alternate_mode=tailscale
      else
        first_caption="$remote_caption"; second_caption="$local_caption"; alternate_mode=localhost
      fi
      printf '  1. %s\n' "$first_caption"
      printf '  %s2. %s%s\n' "$dim" "$second_caption" "$reset"
      prompt answer "  Choose [1]: "
      case "${answer:-1}" in 1) ;; 2) access_mode="$alternate_mode" ;; *) fail "choose 1 or 2" ;; esac
    fi
    if [ "$installed" -eq 0 ]; then
      if [ -z "$source_repository" ]; then
        prompt source_repository "  Release image repository [ghcr.io/lucasmeijer/agents-in-the-cloud]: "
        source_repository="${source_repository:-ghcr.io/lucasmeijer/agents-in-the-cloud}"
      fi
      if [ -z "$tailscale_hostname" ]; then
        prompt tailscale_hostname "  Tailscale hostname [agents-in-the-cloud-system]: "
        tailscale_hostname="${tailscale_hostname:-agents-in-the-cloud-system}"
      fi
      [[ "$source_repository" =~ ^(ghcr\.io|docker\.io)/[a-z0-9]+([._-][a-z0-9]+)*/[a-z0-9]+([._/-][a-z0-9]+)*$ ]] || fail "Use a GHCR or Docker Hub app repository"
      [[ "$tailscale_hostname" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "Invalid Tailscale hostname"
      system_image="${system_image_override:-$source_repository-system:latest}"
      app_image="${app_image_override:-$source_repository:latest}"
    else
      old_system_image="$(docker inspect --format '{{.Image}}' "$system_name")"
      plan_operation=plan; if [ "$action" = rollback ]; then plan_operation=rollback-plan; fi
      plan="$(release_plan "$old_system_image" "$plan_operation" 2>>"$log_file")" || fail "Cannot read the saved release source; nothing was replaced"
      plan_fields=(); while IFS= read -r field; do plan_fields+=("$field"); done <<<"$plan"
      [ "${#plan_fields[@]}" -eq 3 ] || fail "Invalid saved release plan; nothing was replaced"
      system_image="${plan_fields[0]}"; app_image="${plan_fields[1]}"; tailscale_hostname="${plan_fields[2]}"
    fi
    if [ -z "$registry_config" ] && [ "$installed" -eq 1 ] && [ "$action" != rollback ]; then
      auth_present="$(release_plan "$old_system_image" auth-check 2>>"$log_file")" || fail "Cannot inspect saved registry access"
      case "$auth_present" in
        1)
          registry_directory="$(mktemp -d /tmp/agents-in-the-cloud-registry.XXXXXX)"; chmod 700 "$registry_directory"
          if [ "$host_os" = Darwin ] && [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then chown "$SUDO_USER" "$registry_directory"; fi
          docker cp "$system_name:/data/supervisor/docker-auth/config.json" "$registry_directory/config.json" >>"$log_file" 2>&1 || fail "Cannot read saved registry access"
          chmod 600 "$registry_directory/config.json" ;;
        0) ;;
        *) fail "Invalid saved registry access status" ;;
      esac
    fi
    if [ -n "$registry_config" ]; then
      [ -f "$registry_config" ] || fail "Registry config file not found"
      registry_directory="$(mktemp -d /tmp/agents-in-the-cloud-registry.XXXXXX)"
      chmod 700 "$registry_directory"
      cp "$registry_config" "$registry_directory/config.json"; chmod 600 "$registry_directory/config.json"
    fi
    if [ -n "$registry_directory" ] && [ "$host_os" = Darwin ] && [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
      chown "$SUDO_USER" "$registry_directory" "$registry_directory/config.json"
    fi
    # Retain existing host port publications; replacements must not reset access.
    publication_args=()
    if [ "$installed" -eq 1 ]; then
      saved_publications="$(docker inspect --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{if ne $port "3080/tcp"}}{{range $bindings}}{{.HostIp}}:{{.HostPort}}:{{$port}}{{println}}{{end}}{{end}}{{end}}' "$system_name")"
      while IFS= read -r mapping; do
        [ -n "$mapping" ] || continue
        [[ "$mapping" =~ ^(.*):([0-9]+):([0-9]+)/(tcp|udp)$ ]] || fail "Invalid retained port publication"
        host_ip="${BASH_REMATCH[1]:-0.0.0.0}"
        [[ "$host_ip" != *:* ]] || host_ip="[$host_ip]"
        publication_args+=(--publish "$host_ip:${BASH_REMATCH[2]}:${BASH_REMATCH[3]}/${BASH_REMATCH[4]}")
      done <<<"$saved_publications"
    fi
    pull_log_start="$(($(wc -l <"$log_file") + 1))"
    if [ "$action" = rollback ]; then
      docker image inspect "$system_image" >>"$log_file" 2>&1 || fail "Previous System image is no longer retained; nothing was replaced"
    fi
    if [[ "$system_image" == ghcr.io/* || "$system_image" == docker.io/* ]] || ! docker image inspect "$system_image" >>"$log_file" 2>&1; then
    if ! run_quiet_status "Downloading AgentsInTheCloud services" host_pull "$system_image"; then
      fail "Cannot pull the selected System image. Check the repository and Docker registry login; no upstream fallback was attempted. See the bootstrap log."
    fi
    fi
    requested_system_image="$system_image"
    system_image="$(docker image inspect --format '{{.Id}}' "$system_image")"
    [[ "$system_image" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "System image was not pinned; nothing was replaced"
    if [ "$action" != rollback ]; then
      capability="$(docker image inspect --format '{{index .Config.Labels "agents-in-the-cloud.installer-config"}}' "$system_image")"
      [ "$capability" = 1 ] || fail "The selected System image does not support this installer. Use a System image built from the fork release-source branch; nothing was replaced"
    fi
    # Validate the persisted plan with the exact selected image before stopping anything.
    plan="$(release_plan "$system_image" "${plan_operation:-plan}" 2>>"$log_file")" || fail "The selected System image cannot validate this installation"
    plan_fields=(); while IFS= read -r field; do plan_fields+=("$field"); done <<<"$plan"
    [ "${#plan_fields[@]}" -eq 3 ] && [ "${plan_fields[0]}" = "$requested_system_image" ] || fail "Release settings changed during preparation; nothing was replaced"
    app_image="${plan_fields[1]}"; tailscale_hostname="${plan_fields[2]}"
    if [ "$installed" -eq 1 ]; then
      if [ "$action" != rollback ] && [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
        run_quiet "Starting System to prepare the selected app" docker start "$system_name"
      fi
      if [ -n "$registry_directory" ]; then
        run_quiet "Preparing private registry access" docker run --rm -i --network none --entrypoint bun --mount "source=$system_name,target=/data" "$system_image" -e "$release_config_script" credentials "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "" "" - < "$registry_directory/config.json"
      fi
      if [ "$action" = rollback ]; then
        pinned_app="$app_image"
      else
        for ((attempt=0; attempt<60; attempt++)); do
          if docker exec "$system_name" docker info >>"$log_file" 2>&1; then break; fi
          sleep 1
        done
        [ "$attempt" -lt 60 ] || fail "Inner Docker is unavailable; existing System was not replaced"
        pinned_app="$(prepare_installed_app 2>>"$log_file")" || fail "Cannot prepare the selected app; existing System was not replaced"
      fi
      [[ "$pinned_app" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "App image was not pinned; nothing was replaced"
    fi
    if [ "$installed" -eq 1 ]; then
      run_quiet "Stopping AgentsInTheCloud services" docker stop --time 120 "$system_name"
      run_quiet "Replacing AgentsInTheCloud services" docker rm "$system_name"
    fi
    apply_operation=apply; if [ "$action" = rollback ]; then apply_operation=rollback-apply; fi
    if [ -n "$registry_directory" ]; then
      run_quiet "Saving installation source and hostname" docker run --rm -i --network none --entrypoint bun --mount "source=$system_name,target=/data" "$system_image" -e "$release_config_script" "$apply_operation" "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "$system_image" "$pinned_app" - "$old_system_image" < "$registry_directory/config.json"
    else
      run_quiet "Saving installation source and hostname" docker run --rm --network none --entrypoint bun --mount "source=$system_name,target=/data" "$system_image" -e "$release_config_script" "$apply_operation" "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "$system_image" "$pinned_app" "" "$old_system_image"
    fi
    stop_on_failure=1
    run_quiet "Starting AgentsInTheCloud services" docker run -d --name "$system_name" --hostname "$tailscale_hostname" --privileged --cgroupns=host --restart unless-stopped \
      --stop-timeout 120 --tmpfs /run --mount "source=$system_name,target=/data" --publish 127.0.0.1:3080:3080 "${publication_args[@]}" \
      "$system_image" --app-image "$app_image" --access-mode "${access_mode:-tailscale}"
    ;;
  connect)
    access_mode="${access_mode:-tailscale}"
    if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
      stop_on_failure=1
      run_quiet "Starting AgentsInTheCloud services" docker start "$system_name"
    fi
    ;;
  open) ;;
esac
if [ "$action" = install ] || [ "$action" = update ] || [ "$action" = rollback ] || [ "$action" = connect ] || [ -n "$access_mode" ]; then
  local_port="$(docker inspect --format '{{(index (index .HostConfig.PortBindings "3080/tcp") 0).HostPort}}' "$system_name")"
  for ((attempt=0; attempt<60; attempt++)); do
    check_system_running
    if docker exec "$system_name" bun -e '
      const [localPort, mode] = process.argv.slice(1);
      const response = await fetch("http://127.0.0.1:3001/access", {
        method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({localPort:Number(localPort), ...(mode ? {mode} : {})}),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`System access setup: ${response.status}`);
    ' "$local_port" "$access_mode" >>"$log_file" 2>&1; then break; fi
    sleep 1
  done
  [ "$attempt" -lt 60 ] || fail "Could not configure access"
fi
wait_for_system
