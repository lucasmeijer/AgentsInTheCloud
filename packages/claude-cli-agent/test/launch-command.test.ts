import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliAgentSession, CliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { shellQuote } from "@agents-in-the-cloud/core";
import { claudeLaunchScript } from "../src/server/launch-command.ts";
import { claudeInstructionsPath, claudeMcpConfigPath } from "../src/server/session.ts";

let home: string;
let defaultSession: CliAgentSession;
let baseArgs: string[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "claude-launch-"));
  defaultSession = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/turn-signal.sh` };
  baseArgs = expectedBaseArgs(defaultSession);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function executable(path: string, script: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/bash\n${script}`);
  await chmod(path, 0o755);
}
function launch(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings = {}, session = defaultSession, resume = false) {
  return claudeLaunchScript(input, imagePaths, settings, session, resume);
}

function run(script: string) {
  const child = Bun.spawn(["/bin/bash", "-c", script], { env: { ...process.env, HOME: home, PATH: `${home}/.local/bin:${home}/tools:/usr/local/bin:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}
const empty = { text: "", images: [], attachmentNotes: [] };
const sessionId = "1f2e3d4c-0000-4000-8000-000000000001";
function expectedBaseArgs(session: CliAgentSession): string[] {
  const hook = (boundary: string) => [{ hooks: [{ type: "command", command: `sh ${shellQuote(session.turnSignalCommand)} ${boundary}` }] }];
  return ["--dangerously-skip-permissions", "--settings", JSON.stringify({ skipDangerousModePermissionPrompt: true, theme: "custom:agents-in-the-cloud", hooks: { UserPromptSubmit: hook("started"), Stop: hook("finished"), StopFailure: hook("failed") } }), "--append-system-prompt-file", claudeInstructionsPath(session), "--mcp-config", claudeMcpConfigPath(session), "--session-id", session.id];
}

test("reuses home Claude and passes initial prompt, image paths and file notes as literal arguments", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const text = `--help 'quoted' $(touch ${home}/injected)\nsecond line`;
  const notes = "[Attached file copied into the workspace at /tmp/agents-in-the-cloud-attachments/my file.txt]";
  const image = "/tmp/agents-in-the-cloud-attachments/image 1.png";
  const [code, output] = await run(launch({ ...empty, text, attachmentNotes: [notes] }, [image]));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--", `${text}\n\n${notes}\n\nRead the attached image at ${JSON.stringify(image)}.`]);
  expect(await Bun.file(`${home}/injected`).exists()).toBe(false);
});

test("empty launch has no initial prompt argument", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(launch(empty, []));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual(baseArgs);
});

test("concurrent launches install latest once in shared home and both run", async () => {
  await executable(`${home}/tools/npm`, `printf '%s\\n' "$*" >> ${shellQuote(`${home}/installs`)}
sleep .1
mkdir -p "$3/node_modules/.bin"
printf '#!/bin/sh\\nprintf "CLAUDE_STARTED\\\\n"\\n' > "$3/node_modules/.bin/claude"
chmod +x "$3/node_modules/.bin/claude"`);
  await executable(`${home}/.local/bin/claude`, "echo OLD_INSTALL; exit 9");
  const results = await Promise.all([run(launch(empty, [])), run(launch(empty, []))]);
  for (const [code, output] of results) { expect(code).toBe(0); expect(output).toContain("CLAUDE_STARTED"); }
  const installs = (await readFile(`${home}/installs`, "utf8")).trim().split("\n");
  expect(installs).toHaveLength(1);
  expect(installs[0]).toContain("@anthropic-ai/claude-code@latest");
  expect(await Bun.file(`${home}/.claude/local/node_modules/.bin/claude`).exists()).toBe(true);
});

test("installation failure exits visibly without running a fallback shell", async () => {
  await executable(`${home}/tools/npm`, "echo registry-unavailable >&2; exit 42");
  const [code, output, error] = await run(launch(empty, []));
  expect(code).toBe(42);
  expect(error).toContain("registry-unavailable");
  expect(output).toContain("Claude Code failed (exit 42)");
  expect(await Bun.file(`${home}/.claude/local/node_modules/.bin/claude`).exists()).toBe(false);
});

test("Claude startup failure retains its exit code and diagnostics", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, "echo invalid-configuration >&2; exit 7");
  const [code, output, error] = await run(launch(empty, []));
  expect(code).toBe(7);
  expect(error).toContain("invalid-configuration");
  expect(output).toContain("Claude Code failed (exit 7)");
});

test("passes the chosen Claude model and thinking level to the CLI", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(launch(empty, [], { model: "anthropic::claude-opus-4-6", thinkingLevel: "high" }));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--model", "claude-opus-4-6", "--effort", "high"]);
});

test("prepares onboarding and workspace trust while preserving existing preferences", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  await writeFile(`${home}/.claude.json`, JSON.stringify({ theme: "light", custom: "keep", projects: { "/work": { allowedTools: ["Read"] }, "/other": { hasTrustDialogAccepted: true } } }));
  const [code] = await run(launch(empty, []));
  expect(code).toBe(0);
  expect(JSON.parse(await readFile(`${home}/.claude.json`, "utf8"))).toEqual({
    theme: "light", custom: "keep", installMethod: "local", autoUpdates: true, hasCompletedOnboarding: true,
    projects: { "/work": { allowedTools: ["Read"], hasTrustDialogAccepted: true }, "/other": { hasTrustDialogAccepted: true } },
  });
});

test("invalid CLI preferences fail visibly rather than being overwritten", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'echo SHOULD_NOT_START');
  await writeFile(`${home}/.claude.json`, "invalid json");
  const [code, output, error] = await run(launch(empty, []));
  expect(code).not.toBe(0);
  expect(error).toContain("SyntaxError");
  expect(output).not.toContain("SHOULD_NOT_START");
  expect(await readFile(`${home}/.claude.json`, "utf8")).toBe("invalid json");
});

test("installs the AgentsInTheCloud Claude theme so inline code follows the terminal palette", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const [code] = await run(launch(empty, []));
  expect(code).toBe(0);
  expect(JSON.parse(await readFile(`${home}/.claude/themes/agents-in-the-cloud.json`, "utf8"))).toMatchObject({ base: "dark-ansi" });
});

for (const preferences of [{}, { autoUpdates: false }, { installMethod: "native", autoUpdates: false, autoUpdatesProtectedForNative: true }]) {
  test(`enables local Claude self-updates before launch with preferences ${JSON.stringify(preferences)}`, async () => {
    await writeFile(`${home}/.claude.json`, JSON.stringify(preferences));
    await executable(`${home}/.claude/local/node_modules/.bin/claude`, `node -e 'const fs = require("node:fs"); process.stdout.write(fs.readFileSync(process.env.HOME + "/.claude.json", "utf8"))'`);
    const [code, output] = await run(launch(empty, []));
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ...preferences, installMethod: "local", autoUpdates: true });
  });
}

test("registers session-local turn boundary hooks", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const command = `${home}/turn signal.sh`;
  const [code, output] = await run(launch(empty, [], {}, { id: sessionId, directory: `${home}/session`, turnSignalCommand: command }));
  expect(code).toBe(0);
  const args = output.split("\0");
  expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toMatchObject({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `sh ${shellQuote(command)} started` }] }],
    Stop: [{ hooks: [{ type: "command", command: `sh ${shellQuote(command)} finished` }] }],
    StopFailure: [{ hooks: [{ type: "command", command: `sh ${shellQuote(command)} failed` }] }],
  } });
});

test("adds the session-local AgentsInTheCloud MCP configuration without disabling the user's own servers", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const session = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/turn signal.sh` };
  const [code, output] = await run(launch(empty, [], {}, session));
  expect(code).toBe(0);
  const args = output.split("\0");
  expect(args[args.indexOf("--mcp-config") + 1]).toBe(claudeMcpConfigPath(session));
  expect(args[args.indexOf("--session-id") + 1]).toBe(sessionId);
  expect(args).not.toContain("--strict-mcp-config");
  expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe(claudeInstructionsPath(session));
  expect(args).not.toContain("--append-system-prompt");
});


test("native resume restores the exact conversation with no submitted prompt", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const session = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/turn-signal.sh` };
  const [code, output] = await run(launch(empty, [], {}, session, true));
  expect(code).toBe(0);
  const args = output.split("\0").slice(0, -1);
  expect(args.join(" ")).toContain(["--resume", sessionId].join(" "));
  expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe(claudeInstructionsPath(session));
  expect(args).not.toContain("--session-id");
  expect(args).not.toContain("--");
});
