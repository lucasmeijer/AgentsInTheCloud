import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliAgentSession, CliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { shellQuote } from "@agents-in-the-cloud/core";
import { piLaunchScript } from "../src/server/launch-command.ts";
import { piAgentsInTheCloudExtensionPath } from "../src/server/session.ts";

let home: string;
let defaultSession: CliAgentSession;
let baseArgs: string[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-launch-"));
  defaultSession = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/turn-signal.sh` };
  baseArgs = expectedBaseArgs(defaultSession);
  await writeFile(`${home}/.pi-cli-update-check`, String(Math.floor(Date.now() / 1000)));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const binary = () => `${home}/.pi/agent/bin/pi`;
async function executable(path: string, script: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/bash\n${script}`);
  await chmod(path, 0o755);
}
function launch(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings = {}, session = defaultSession, resumePath?: string) {
  return piLaunchScript(input, imagePaths, settings, session, resumePath);
}

function run(script: string) {
  const child = Bun.spawn(["/bin/bash", "-c", script], { env: { ...process.env, HOME: home, PATH: `${home}/.local/bin:${home}/tools:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}
const empty = { text: "", images: [], attachmentNotes: [] };
const sessionId = "1f2e3d4c-0000-4000-8000-000000000001";
function expectedBaseArgs(session: CliAgentSession): string[] {
  return ["--approve", "--offline", "--tui-mode", "regular", "--session-dir", `/home/agents-in-the-cloud/.local/share/pi/sessions/${session.id}`, "--extension", piAgentsInTheCloudExtensionPath(session)];
}

test("passes initial prompt, images, file notes, provider and Pi thinking level literally", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const text = `--help 'quoted' $(touch ${home}/injected)\nsecond line`;
  const notes = "File: /tmp/agents-in-the-cloud-attachments/my file.txt";
  const image = "/tmp/agents-in-the-cloud-attachments/image 1.png";
  const [code, output] = await run(launch({ ...empty, text, attachmentNotes: [notes] }, [image], { model: "anthropic::claude", thinkingLevel: "minimal" }));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--provider", "anthropic", "--model", "claude", "--thinking", "minimal", "--", `@${image}`, `${text}\n\n${notes}`]);
  expect(await Bun.file(`${home}/injected`).exists()).toBe(false);
});

test("@-prefixed messages are not interpreted as file arguments by Pi", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const [code, output] = await run(launch({ ...empty, text: "@someone inspect this" }, []));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--", "\n@someone inspect this"]);
});

test("empty launch stays interactive without submitting a prompt", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const [code, output] = await run(launch(empty, []));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--"]);
});

test("concurrent launches install latest once in shared home and both run", async () => {
  await executable(`${home}/tools/npm`, 'echo npm-must-not-be-called >&2; exit 1');
  await executable(`${home}/tools/node`, 'exit 0');
  await executable(`${home}/tools/curl`, `printf '%s\\n' "$*" >> ${shellQuote(`${home}/installs`)}
cat > "$4" <<'INSTALLER'
sleep .1
mkdir -p "$(dirname "$HOME/.pi/agent/bin/pi")"
printf '#!/bin/sh\\nprintf "PI_STARTED\\\\n"\\n' > "$HOME/.pi/agent/bin/pi"
chmod +x "$HOME/.pi/agent/bin/pi"
INSTALLER`);
  const results = await Promise.all([run(launch(empty, [])), run(launch(empty, []))]);
  for (const [code, output] of results) { expect(code).toBe(0); expect(output).toContain("PI_STARTED"); }
  const installs = (await readFile(`${home}/installs`, "utf8")).trim().split("\n");
  expect(installs).toHaveLength(1);
  expect(installs[0]).toContain("https://pi.dev/install.sh");
  expect(await Bun.file(`${home}/.pi/agent/bin/pi`).exists()).toBe(true);
  expect(await Bun.file(binary()).exists()).toBe(true);
});

test("installation and startup failures keep their exit codes and diagnostics", async () => {
  await executable(`${home}/tools/curl`, "echo registry-unavailable >&2; exit 42");
  const [code, output, error] = await run(launch(empty, []));
  expect(code).toBe(42);
  expect(error).toContain("registry-unavailable");
  expect(output).toContain("Pi failed (exit 42)");
  await executable(binary(), "echo invalid-configuration >&2; exit 7");
  const [startupCode, startupOutput, startupError] = await run(launch(empty, []));
  expect(startupCode).toBe(7);
  expect(startupError).toContain("invalid-configuration");
  expect(startupOutput).toContain("Pi failed (exit 7)");
});

test("loads the session's AgentsInTheCloud extension", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const session = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/turn-signal.sh` };
  const [code, output] = await run(launch(empty, [], {}, session));
  expect(code).toBe(0);
  expect(output.split("\0")).toContain(piAgentsInTheCloudExtensionPath(session));
  expect(output.split("\0")).toContain(`/home/agents-in-the-cloud/.local/share/pi/sessions/${sessionId}`);
});

test("native resume restores the exact conversation with no submitted prompt", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const session = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/turn-signal.sh` };
  const [code, output] = await run(launch(empty, [], {}, session, "/home/agents-in-the-cloud/.local/share/pi/sessions/tab/saved.jsonl"));
  expect(code).toBe(0);
  const args = output.split("\0").slice(0, -1);
  expect(args.join(" ")).toContain(["--session", "/home/agents-in-the-cloud/.local/share/pi/sessions/tab/saved.jsonl"].join(" "));
  expect(args.at(-1)).toBe("--");
});
