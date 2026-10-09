#!/usr/bin/env bash
# usage: apt-layer.sh <layer> <layers> <package>...
#
# Installs layer <layer> of <layers> of one apt install, so a large install
# becomes several image layers that download in parallel. Each layer takes the
# next packages in apt's install order, up to an even share of the
# Installed-Size still missing. The last layer installs whatever remains, so
# the result matches a single install of the packages.
set -euo pipefail
layer=$1 layers=$2
shift 2

apt-get update
if [ "$layer" -eq "$layers" ]; then
  apt-get install -y --no-install-recommends "$@"
  exit
fi

# Inst lines name each package apt would unpack, in order; an upgrade also shows "[old version]".
plan=()
declare -A upgrade
while read -r package old; do
  plan+=("$package")
  [[ $old != \[* ]] || upgrade[$package]=1
done < <(apt-get install -s --no-install-recommends "$@" | awk '$1 == "Inst" { print $2, $3 }')
[ "${#plan[@]}" -gt 0 ] || exit 0
declare -A kib
while read -r name size; do kib[$name]=$size; done < <(
  apt-cache show --no-all-versions "${plan[@]}" | awk '$1 == "Package:" { name = $2 } $1 == "Installed-Size:" { print name, $2 }'
)

missing=0
for package in "${plan[@]}"; do missing=$((missing + ${kib[${package%%:*}]})); done
share=$((missing / (layers - layer + 1)))

slice=() taken=0
for package in "${plan[@]}"; do
  [ "$taken" -lt "$share" ] || break
  slice+=("$package")
  taken=$((taken + ${kib[${package%%:*}]}))
done
apt-get install -y --no-install-recommends "${slice[@]}"

# Naming a new dependency marks it manually installed. Keep that mark for the
# requested packages only; upgraded packages keep the mark they already had.
declare -A requested
for package in "$@"; do requested[$package]=1; done
dependencies=()
for package in "${slice[@]}"; do
  [ -n "${requested[${package%%:*}]:-}" ] || [ -n "${upgrade[$package]:-}" ] || dependencies+=("$package")
done
[ "${#dependencies[@]}" -eq 0 ] || apt-mark auto "${dependencies[@]}" >/dev/null
