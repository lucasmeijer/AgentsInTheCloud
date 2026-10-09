#!/usr/bin/env bash
set -Eeuo pipefail

system_image=ghcr.io/lucasmeijer/agents-in-the-cloud-system:latest
app_image=ghcr.io/lucasmeijer/agents-in-the-cloud:latest
action=""
uninstall_requested=0
access_mode=""
admin_publish=()
admin_publish_disabled=0
admin_allow_all=0
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
  "$@" >>"$log_file" 2>&1 &
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

  --system-image REF   System image (default: ghcr.io/lucasmeijer/agents-in-the-cloud-system:latest)
  --app-image REF      First-install app image (default: ghcr.io/lucasmeijer/agents-in-the-cloud:latest)
  --access-mode MODE  localhost or tailscale (default selected for this machine)
  --admin-publish IP:HOST_PORT:ADMIN_PORT  Publish an admin listener (repeatable; TLS/token setup separate)
  --no-admin-publish   Remove all admin port publications on install/update
  --allow-admin-all-interfaces  Explicitly allow 0.0.0.0 admin publication (all host interfaces)
  --action ACTION     install, update, connect, or open
                      connect enables Tailscale without replacing an existing installation
  --uninstall         Permanently delete installation data (also supports Atelier System)
  -h, --help          Show help

The app image is only used when System has no persisted app selection.
There is no migration from the previous AgentsInTheCloud installation layout.
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --system-image|--app-image|--action|--access-mode)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$1" in
        --system-image) system_image="$2" ;;
        --app-image) app_image="$2" ;;
        --action) action="$2" ;;
        --access-mode) access_mode="$2" ;;
      esac
      shift 2 ;;
    --admin-publish)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires IP:HOST_PORT:ADMIN_PORT"
      admin_publish+=("$2"); shift 2 ;;
    --no-admin-publish) admin_publish_disabled=1; shift ;;
    --allow-admin-all-interfaces) admin_allow_all=1; shift ;;
    --uninstall) uninstall_requested=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
if [ "$uninstall_requested" -eq 1 ]; then
  [ -z "$action" ] || fail "--uninstall cannot be combined with --action"
  action=uninstall
fi
case "$action" in ""|install|update|connect|open|uninstall) ;; *) fail "unknown action: $action" ;; esac
case "$access_mode" in ""|localhost|tailscale) ;; *) fail "unknown access mode: $access_mode" ;; esac
validate_admin_publish() {
  local mapping="$1" ip host_port container_port octet
  local -a octets
  [[ "$mapping" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}:[0-9]{1,5}$ ]] || fail "--admin-publish requires an explicit IPv4 IP:HOST_PORT:ADMIN_PORT"
  IFS=: read -r ip host_port container_port <<<"$mapping"
  IFS=. read -r -a octets <<<"$ip"
  for octet in "${octets[@]}"; do [ "$((10#$octet))" -le 255 ] || fail "Invalid admin publication IP"; done
  host_port=$((10#$host_port)); container_port=$((10#$container_port))
  [ "$host_port" -ge 1024 ] && [ "$host_port" -le 65535 ] && [ "$container_port" -ge 1024 ] && [ "$container_port" -le 65535 ] || fail "Admin ports must be between 1024 and 65535"
  case "$container_port" in 2999|3000|3001|3080|24800) fail "Cannot publish an internal management or gateway port as an admin listener" ;; esac
  [ "$container_port" -lt 41000 ] || [ "$container_port" -gt 41999 ] || fail "Cannot publish a workspace preview port as an admin listener"
}
[ "$admin_publish_disabled" -eq 0 ] || [ "${#admin_publish[@]}" -eq 0 ] || fail "--no-admin-publish cannot be combined with --admin-publish"
for mapping in "${admin_publish[@]}"; do
  validate_admin_publish "$mapping"
  if [[ "$mapping" == 0.0.0.0:* ]]; then
    [ "$admin_allow_all" -eq 1 ] || fail "0.0.0.0 exposes all host interfaces; requires --allow-admin-all-interfaces"
    printf 'Warning: admin publication covers all interfaces, possibly public. Docker publication may bypass host firewall rules.\n' >&2
  fi
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
update_app_channel() {
  local start=$SECONDS code reply last_action="" current_action description
  local -a fields
  while true; do
    check_system_running
    code=0
    docker exec "$system_name" bun -e '
      let response;
      try {
        response = await fetch("http://127.0.0.1:3001/update-channel", {
          method: "POST", signal: AbortSignal.timeout(3000),
        });
      } catch (error) {
        console.error(error);
        process.exit(75);
      }
      if (response.status === 202) process.exit(0);
      if (response.status === 503 || response.status === 409) process.exit(75);
      console.error(`System channel update: ${response.status} ${await response.text()}`);
      process.exit(2);
    ' >>"$log_file" 2>&1 || code=$?
    case "$code" in
      0) return ;;
      75) ;;
      *) fail "Could not request the AgentsInTheCloud app update. See the bootstrap log for details." ;;
    esac
    # Startup can fail because the saved app is broken. Only the supervisor
    # needs to be available to accept an independent channel update.
    description="Waiting to update AgentsInTheCloud on the selected channel"
    code=0
    reply="$(supervisor_status 2>>"$log_file")" || code=$?
    if [ "$code" -eq 0 ]; then
      fields=()
      while IFS= read -r field; do fields+=("$field"); done <<<"$reply"
      if [ "${fields[0]}" = starting ]; then description="${fields[1]}"; fi
      current_action="${fields[4]:-}"$'\n'"${fields[5]:-}"
      if [ "${fields[0]}" != failed ] && [ -n "${fields[4]:-}" ] && [ "$current_action" != "$last_action" ]; then
        finish_line
        printf '\n  %s\n' "${fields[4]}"
        [ -z "${fields[5]:-}" ] || printf '\n  %s\n\n' "${fields[5]}"
        last_action="$current_action"
      fi
    elif [ "$code" -eq 2 ]; then
      fail "The supervisor returned an invalid status."
    fi
    status "$description" "$((SECONDS-start))s"
    [ "$((SECONDS-start))" -lt 2400 ] || fail "AgentsInTheCloud System did not accept the app update within 40 minutes."
    sleep 1
  done
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
  prompt action "  Choose: open, update, connect, or quit: "
  [ "$action" != quit ] || exit 0
  case "$action" in connect|update|open) ;; *) fail "unknown action: $action" ;; esac
fi

if [ "${#admin_publish[@]}" -gt 0 ] || [ "$admin_publish_disabled" -eq 1 ] || [ "$admin_allow_all" -eq 1 ]; then
  case "$action" in install|update) ;; *) fail "Admin publication options require --action install or update; Docker ports require container replacement" ;; esac
fi

case "$action" in
  install|update)
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
    # Docker port publication is fixed at container creation. Preserve admin mappings on update.
    if [ "$installed" -eq 1 ] && [ "${#admin_publish[@]}" -eq 0 ] && [ "$admin_publish_disabled" -eq 0 ]; then
      saved_admin_publish="$(docker inspect --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{if ne $port "3080/tcp"}}{{range $bindings}}{{.HostIp}}:{{.HostPort}}:{{$port}}{{println}}{{end}}{{end}}{{end}}' "$system_name")"
      while IFS= read -r mapping; do
        [[ "$mapping" == */tcp ]] || continue
        mapping="${mapping%/tcp}"
        validate_admin_publish "$mapping"
        admin_publish+=("$mapping")
      done <<<"$saved_admin_publish"
    fi
    admin_port_args=()
    for mapping in "${admin_publish[@]}"; do admin_port_args+=(--publish "$mapping"); done
    pull_log_start="$(($(wc -l <"$log_file") + 1))"
    if ! run_quiet_status "Downloading AgentsInTheCloud services" docker pull "$system_image"; then
      # GHCR rejects a stale saved login even for public images, instead of falling back to anonymous access.
      if [[ "$system_image" == ghcr.io/* ]] && [[ "$(tail -n "+$pull_log_start" "$log_file")" == *denied* ]]; then
        docker_logout="docker logout ghcr.io"
        # When Docker runs through sudo on Linux, the rejected login belongs to root.
        if [ "$host_os" = Linux ] && { [ "$docker_via_sudo" -eq 1 ] || [ -n "${SUDO_USER:-}" ]; }; then docker_logout="sudo $docker_logout"; fi
        fail "GitHub turned down Docker's saved login for ghcr.io, so the download stopped. AgentsInTheCloud images are public and don't need it. Run: $docker_logout, then run this installer again."
      fi
      fail "Downloading AgentsInTheCloud services failed. See the bootstrap log for details."
    fi
    if [ "$installed" -eq 1 ]; then
      run_quiet "Stopping AgentsInTheCloud services" docker stop --time 120 "$system_name"
      run_quiet "Replacing AgentsInTheCloud services" docker rm "$system_name"
    fi
    stop_on_failure=1
    run_quiet "Starting AgentsInTheCloud services" docker run -d --name "$system_name" --hostname agents-in-the-cloud-system --privileged --cgroupns=host --restart unless-stopped \
      --stop-timeout 120 --tmpfs /run --mount source=agents-in-the-cloud-system,target=/data --publish 127.0.0.1:3080:3080 "${admin_port_args[@]}" \
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
if [ "$action" = install ] || [ "$action" = update ] || [ "$action" = connect ] || [ -n "$access_mode" ]; then
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
if [ "$action" = update ]; then update_app_channel; fi
wait_for_system
