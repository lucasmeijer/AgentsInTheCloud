import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliAgentSession, CliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { shellQuote } from "@agents-in-the-cloud/core";
import { codexLaunchScript } from "../src/server/launch-command.ts";

let home: string;
let defaultSession: CliAgentSession;
let baseArgs: string[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codex-launch-"));
  defaultSession = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/turn-signal.sh` };
  await mkdir(`${home}/session/codex`, { recursive: true });
  await writeFile(`${home}/session/codex/instructions.override`, 'developer_instructions="guidance"');
  await writeFile(`${home}/session/codex/mcp.override`, 'mcp_servers.agents-in-the-cloud={url="http://localhost/mcp"}');
  baseArgs = expectedBaseArgs(defaultSession);
  await writeFile(`${home}/.codex-cli-update-check`, String(Math.floor(Date.now() / 1000)));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function executable(path: string, script: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/bash\n${script}`);
  await chmod(path, 0o755);
}
function launch(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings = {}, session = defaultSession, resumeId?: string) {
  return codexLaunchScript(input, imagePaths, settings, session, resumeId);
}

function run(script: string) {
  const child = Bun.spawn(["/bin/bash", "-c", script], { env: { ...process.env, HOME: home, PATH: `${home}/.local/bin:${home}/tools:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}
const empty = { text: "", images: [], attachmentNotes: [] };
const sessionId = "1f2e3d4c-0000-4000-8000-000000000001";
function expectedBaseArgs(session: CliAgentSession): string[] {
  return ["-c", 'developer_instructions="guidance"', "-c", 'mcp_servers.agents-in-the-cloud={url="http://localhost/mcp"}', "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--no-alt-screen", "--cd", "/work", "-c", `sqlite_home=${JSON.stringify(`${session.directory}/codex`)}`, "-c", 'projects={"/work"={trust_level="trusted"}}',
    "-c", `notify=${JSON.stringify(["sh", session.turnSignalCommand, "finished"])}`,
    "-c", `hooks={SessionStart=[{hooks=[{type="command",command=${JSON.stringify(`node ${shellQuote(`${session.directory}/codex/session-start.cjs`)}`)}}]}],UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(`sh ${shellQuote(session.turnSignalCommand)} started`)}}]}]}`,
    "-c", 'tui.theme="agents-in-the-cloud"', "-c", "notice.hide_full_access_warning=true", "-c", 'cli_auth_credentials_store="file"'];
}

test("reuses home Codex and passes initial prompt, image paths and file notes as literal arguments", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, 'printf "%s\\0" "$@"');
  const text = `--help 'quoted' $(touch ${home}/injected)\nsecond line`;
  const notes = "[Attached file copied into the workspace at /tmp/agents-in-the-cloud-attachments/my file.txt]";
  const image = "/tmp/agents-in-the-cloud-attachments/image 1.png";
  const [code, output] = await run(launch({ ...empty, text, attachmentNotes: [notes] }, [image]));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--image", image, "--", `${text}\n\n${notes}`]);
  expect(await Bun.file(`${home}/injected`).exists()).toBe(false);
});

test("empty launch has no initial prompt argument", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(launch(empty, []));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual(baseArgs);
});

test("concurrent launches install latest once in shared home and both run", async () => {
  await executable(`${home}/tools/npm`, 'echo npm-must-not-be-called >&2; exit 1');
  await executable(`${home}/tools/node`, 'exit 0');
  await executable(`${home}/tools/curl`, `printf '%s\\n' "$*" >> ${shellQuote(`${home}/installs`)}
cat > "$4" <<'INSTALLER'
sleep .1
mkdir -p "$(dirname "$HOME/.codex/packages/standalone/current/bin/codex")"
printf '#!/bin/sh\\nprintf "CODEX_STARTED\\\\n"\\n' > "$HOME/.codex/packages/standalone/current/bin/codex"
chmod +x "$HOME/.codex/packages/standalone/current/bin/codex"
INSTALLER`);
  const results = await Promise.all([run(launch(empty, [])), run(launch(empty, []))]);
  for (const [code, output] of results) { expect(code).toBe(0); expect(output).toContain("CODEX_STARTED"); }
  const installs = (await readFile(`${home}/installs`, "utf8")).trim().split("\n");
  expect(installs).toHaveLength(1);
  expect(installs[0]).toContain("https://chatgpt.com/codex/install.sh");
  expect(await Bun.file(`${home}/.codex/packages/standalone/current/bin/codex`).exists()).toBe(true);
});

test("installation failure exits visibly without running a fallback shell", async () => {
  await executable(`${home}/tools/curl`, "echo registry-unavailable >&2; exit 42");
  const [code, output, error] = await run(launch(empty, []));
  expect(code).toBe(42);
  expect(error).toContain("registry-unavailable");
  expect(output).toContain("Codex CLI failed (exit 42)");
  expect(await Bun.file(`${home}/.codex/packages/standalone/current/bin/codex`).exists()).toBe(false);
});

test("Codex CLI startup failure retains its exit code and diagnostics", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, "echo invalid-configuration >&2; exit 7");
  const [code, output, error] = await run(launch(empty, []));
  expect(code).toBe(7);
  expect(error).toContain("invalid-configuration");
  expect(output).toContain("Codex CLI failed (exit 7)");
});

test("passes the chosen Codex model and thinking level to the CLI", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(launch(empty, [], { model: "openai-codex::gpt-5.4", thinkingLevel: "high" }));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--model", "gpt-5.4", "-c", 'model_reasoning_effort="high"']);
});

test("registers session-local turn boundary notifications", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, 'printf "%s\\0" "$@"');
  const command = `${home}/turn signal.sh`;
  const [code, output] = await run(launch(empty, [], {}, { id: sessionId, directory: `${home}/session`, turnSignalCommand: command }));
  expect(code).toBe(0);
  const args = output.split("\0");
  expect(args).toContain(`notify=${JSON.stringify(["sh", command, "finished"])}`);
  expect(args).toContain(`hooks={SessionStart=[{hooks=[{type="command",command=${JSON.stringify(`node ${shellQuote(`${home}/session/codex/session-start.cjs`)}`)}}]}],UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(`sh ${shellQuote(command)} started`)}}]}]}`);
});

test("installs the AgentsInTheCloud syntax theme in the shared home with terminal palette colors", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, 'printf "%s\\0" "$@"');
  const [code] = await run(`CODEX_HOME=${shellQuote(`${home}/session-codex`)}\n${launch(empty, [])}`);
  expect(code).toBe(0);
  const theme = await readFile(`${home}/.codex/themes/agents-in-the-cloud.tmTheme`, "utf8");
  // Inline code uses palette slot 12 (bright blue), AgentsInTheCloud's accent.
  expect(theme).toContain("<string>markup.inline.raw.string.markdown, markup.raw.inline.markdown</string><key>settings</key><dict><key>foreground</key><string>#0c000000</string>");
});


test("native resume restores the exact conversation with no submitted prompt", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, 'printf "%s\\0" "$@"');
  const session = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/turn-signal.sh` };
  const [code, output] = await run(launch(empty, [], {}, session, "native-session-id"));
  expect(code).toBe(0);
  const args = output.split("\0").slice(0, -1);
  expect(args.join(" ")).toContain(["resume", "native-session-id"].join(" "));
  expect(args).not.toContain("--");
});

test("private config overrides are passed literally, never evaluated as shell commands", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, 'printf "%s\\0" "$@"');
  const override = `developer_instructions="$(touch ${home}/injected)"`;
  await writeFile(`${home}/session/codex/instructions.override`, override);
  const [code, output] = await run(launch(empty, []));
  expect(code).toBe(0);
  expect(output.split("\0")).toContain(override);
  expect(await Bun.file(`${home}/injected`).exists()).toBe(false);
});

test("older private rollouts remain resumable without overwriting an existing shared rollout", async () => {
  await executable(`${home}/.codex/packages/standalone/current/bin/codex`, 'printf "%s\\0" "$@"');
  const privateDirectory = `${home}/session/codex/sessions/2026/01/01`;
  const sharedDirectory = `${home}/.codex/sessions/2026/01/01`;
  await mkdir(privateDirectory, { recursive: true });
  await mkdir(sharedDirectory, { recursive: true });
  await writeFile(`${privateDirectory}/old.jsonl`, "older saved session");
  await writeFile(`${privateDirectory}/existing.jsonl`, "stale copy");
  await writeFile(`${sharedDirectory}/existing.jsonl`, "current shared session");
  expect((await run(launch(empty, [], {}, defaultSession, "native-id")))[0]).toBe(0);
  expect(await readFile(`${sharedDirectory}/old.jsonl`, "utf8")).toBe("older saved session");
  expect(await readFile(`${sharedDirectory}/existing.jsonl`, "utf8")).toBe("current shared session");
});
