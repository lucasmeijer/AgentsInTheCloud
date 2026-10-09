import { shellQuote } from "@agents-in-the-cloud/core";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { workspaceRoot } from "@agents-in-the-cloud/workspace";

/** Resume launches restore native context without submitting a prompt. */
export function emptyAgentInput(): WorkspaceAgentInput {
  return { text: "", images: [], attachmentNotes: [] };
}

export function cliPromptText(input: WorkspaceAgentInput, extraNotes: string[] = []): string {
  return [input.text, ...input.attachmentNotes, ...extraNotes].filter(Boolean).join("\n\n");
}

/** Install once in shared home, then launch in tmux with visible startup diagnostics. */
export function cliLaunchScript(options: { executable: string; label: string; npmPackage: string; version?: string; installDirectory?: string; args: string[]; setup?: string }): string {
  const { executable, label, npmPackage, version, installDirectory, args, setup = "" } = options;
  // Pinned versions and explicit install directories must not reuse a different install from PATH.
  const directory = installDirectory ? `$HOME/${installDirectory}` : `$HOME/.${executable}-cli${version ? `/${version}` : ""}`;
  const resolveExecutable = version || installDirectory ? `executable="${directory}/node_modules/.bin/${executable}"` : `executable="$(command -v ${executable} || true)"
case "$executable" in "$HOME"/*) ;; *) executable="$HOME/.local/bin/${executable}" ;; esac`;
  const linkExecutable = version ? "" : `mkdir -p "$HOME/.local/bin"
  ln -s${installDirectory ? "f" : ""} "${directory}/node_modules/.bin/${executable}" "$HOME/.local/bin/${executable}"`;
  return `set -eu
failure_message=${shellQuote(`\n${label} failed (exit %s). See the error above.\n`)}
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "$failure_message" "$code"; fi' EXIT
# Installation and its lock live in shared home, not workspace-private .local/share.
(
  flock 9
  ${resolveExecutable}
  if [ -x "$executable" ]; then exit 0; fi
  mkdir -p "$(dirname "${directory}")"
  printf '%s\\n' ${shellQuote(`Installing ${version ? `${label} ${version}` : `latest ${label}`} into shared home…`)}
  staging="$(mktemp -d "$HOME/.${executable}-cli-install.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  npm install --prefix "$staging" --no-audit --no-fund ${shellQuote(`${npmPackage}@${version ?? "latest"}`)}
  mv "$staging" "${directory}"
  ${linkExecutable}
) 9> "$HOME/.${executable}-cli-install.lock"
${setup}
${resolveExecutable}
cd ${shellQuote(workspaceRoot)}
"$executable" ${args.map(shellQuote).join(" ")}
`;
}

/** Official installations own their layout and self-update without changing npm configuration. */
export function managedCliLaunchScript(options: { agent: "codex" | "pi"; args: string[]; configOverrides?: string[]; setup?: string }): string {
  const { agent, args, configOverrides = [], setup = "" } = options;
  const label = agent === "codex" ? "Codex CLI" : "Pi";
  const binDirectory = agent === "codex" ? "$HOME/.local/bin" : "$HOME/.pi/agent/bin";
  const binary = agent === "codex" ? "$HOME/.codex/packages/standalone/current/bin/codex" : `${binDirectory}/pi`;
  const installerUrl = agent === "codex" ? "https://chatgpt.com/codex/install.sh" : "https://pi.dev/install.sh";
  const argumentScript = [...configOverrides.map((file) => `-c "$(cat ${shellQuote(file)})"`), ...args.map(shellQuote)].join(" ");
  return `set -eu
failure_message=${shellQuote(`\n${label} failed (exit %s). See the error above.\n`)}
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "$failure_message" "$code"; fi' EXIT
${agent === "codex" ? 'export CODEX_HOME="$HOME/.codex"' : ""}
export PATH="${binDirectory}:$PATH"
(
  flock 9
  cd "$HOME"
  executable="${binary}"
  stamp="$HOME/.${agent}-cli-update-check"
  now="$(date +%s)"
  checked=0
  if [ -f "$stamp" ]; then checked="$(cat "$stamp")"; fi
  if [ ! -x "$executable" ]; then
    printf '%s\\n' ${shellQuote(`Installing latest ${label} into shared home…`)}
    staging="$(mktemp -d "$HOME/.${agent}-cli-install.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    curl -fsSL ${shellQuote(installerUrl)} -o "$staging/install.sh"
    # Keep the user's Node/npm, but hide unrelated CLI installations from installer migration prompts.
    mkdir "$staging/tools"
    ln -s "$(command -v node)" "$staging/tools/node"
    ln -s "$(command -v npm)" "$staging/tools/npm"
    # No controlling terminal: installers cannot prompt or launch an interactive agent.
    # Their own bin directory is on PATH, so they do not need to edit shell profiles.
    PATH="${binDirectory}:$staging/tools:/usr/bin:/bin" setsid --wait sh "$staging/install.sh" </dev/null
    test -x "$executable"
    printf '%s\\n' "$now" > "$stamp"
  elif [ "$((now - checked))" -ge 86400 ]; then
    printf '%s\\n' ${shellQuote(`Checking for ${label} updates…`)}
    if "$executable" update${agent === "pi" ? " --no-approve" : ""}; then
      printf '%s\\n' "$now" > "$stamp"
    else
      printf '%s\\n' ${shellQuote(`${label} update failed. Starting the installed version; we’ll retry next launch.`)}
    fi
  fi
${agent === "pi" ? '  # Keep our terminal launcher on the same managed install as the agent.\n  mkdir -p "$HOME/.local/bin"\n  ln -sfn "$HOME/.pi/agent/bin/pi" "$HOME/.local/bin/pi"' : ""}
) 9> "$HOME/.${agent}-cli-install.lock"
${setup}
cd ${shellQuote(workspaceRoot)}
"${binary}" ${argumentScript}
`;
}

/**
 * Shell lines for `setup` that write a file AgentsInTheCloud owns, such as an agent theme.
 * Rewritten on every launch so changes ship with AgentsInTheCloud. `path` is a shell expression.
 */
export function writeFileScript(path: string, content: string): string {
  return `mkdir -p "$(dirname ${path})"
printf '%s' ${shellQuote(content)} > ${path}`;
}
