import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedCliLaunchScript } from "../src/server/launch-script.ts";

let home: string;
const binary = (agent: "codex" | "pi") => `${home}/${agent === "codex" ? ".codex/packages/standalone/current/bin/codex" : ".pi/agent/bin/pi"}`;
const script = (agent: "codex" | "pi" = "codex") => managedCliLaunchScript({ agent, args: [] });
async function executable(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${content}`);
  await chmod(path, 0o755);
}
function run(command: string) {
  const child = Bun.spawn(["bash", "-c", command], {
    env: { ...process.env, HOME: home, PATH: `${home}/tools:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe",
  });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}
async function installed(agent: "codex" | "pi") {
  await executable(binary(agent), `if [ "$1" = update ]; then
  printf '%s\n' "$*" >> "$HOME/updates"
  if [ -f "$HOME/fail-update" ]; then echo download-unavailable >&2; exit 42; fi
  exit 0
fi
echo INSTALLED`);
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "managed-cli-"));
  await writeFile(`${home}/.npmrc`, "prefix=/my/custom/tools\n");
  await writeFile(`${home}/.bashrc`, "# user preferences\n");
  await executable(`${home}/tools/npm`, "echo npm-must-not-be-called >&2; exit 1");
  await executable(`${home}/tools/node`, "exit 0");
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

for (const agent of ["codex", "pi"] as const) {
  test(`${agent}: concurrent first launches use the official installer once, without a terminal or npm settings changes`, async () => {
    await installed(agent);
    await writeFile(`${home}/installer-binary`, await readFile(binary(agent)));
    await rm(binary(agent));
    await executable(`${home}/tools/curl`, `printf '%s\n' "$2" >> "$HOME/downloads"
cat > "$4" <<'INSTALLER'
set -eu
if ( : <> /dev/tty ) 2>/dev/null || [ -t 0 ]; then echo unexpected-installer-terminal >&2; exit 1; fi
sleep .1
mkdir -p "$(dirname "${binary(agent)}")"
cp "$HOME/installer-binary" "${binary(agent)}"
chmod +x "${binary(agent)}"
INSTALLER`);
    const results = await Promise.all([run(script(agent)), run(script(agent))]);
    for (const [code, output] of results) { expect(code).toBe(0); expect(output).toContain("INSTALLED"); }
    expect((await readFile(`${home}/downloads`, "utf8")).trim().split("\n")).toEqual([agent === "codex" ? "https://chatgpt.com/codex/install.sh" : "https://pi.dev/install.sh"]);
    expect(await readFile(`${home}/.npmrc`, "utf8")).toBe("prefix=/my/custom/tools\n");
    expect(await readFile(`${home}/.bashrc`, "utf8")).toBe("# user preferences\n");
    if (agent === "pi") expect(await readlink(`${home}/.local/bin/pi`)).toBe(binary(agent));
  });

  test(`${agent}: concurrent daily refresh uses the native updater once`, async () => {
    await installed(agent);
    await writeFile(`${home}/.${agent}-cli-update-check`, "0");
    for (const [code] of await Promise.all([run(script(agent)), run(script(agent))])) expect(code).toBe(0);
    expect((await run(script(agent)))[0]).toBe(0);
    expect(await readFile(`${home}/updates`, "utf8")).toBe(agent === "pi" ? "update --no-approve\n" : "update\n");
  });

  test(`${agent}: failed refresh retains diagnostics, starts the installed CLI and retries`, async () => {
    await installed(agent);
    const stamp = `${home}/.${agent}-cli-update-check`;
    await writeFile(stamp, "0");
    await writeFile(`${home}/fail-update`, "");
    const [code, output, error] = await run(script(agent));
    expect(code).toBe(0);
    expect(output).toContain("update failed");
    expect(output).toContain("INSTALLED");
    expect(error).toContain("download-unavailable");
    expect(await readFile(stamp, "utf8")).toBe("0");
    await rm(`${home}/fail-update`);
    expect((await run(script(agent)))[0]).toBe(0);
    expect(await readFile(stamp, "utf8")).not.toBe("0");
  });

  test(`${agent}: native/user updates remain the executable we launch`, async () => {
    await installed(agent);
    await writeFile(`${home}/.${agent}-cli-update-check`, String(Math.floor(Date.now() / 1000)));
    expect((await run(script(agent)))[1]).toContain("INSTALLED");
    await executable(binary(agent), "echo USER_UPDATED");
    expect((await run(script(agent)))[1]).toContain("USER_UPDATED");
    expect(await Bun.file(`${home}/updates`).exists()).toBe(false);
  });
}

test("initial download failure retains its exit code and does not mark the check successful", async () => {
  await executable(`${home}/tools/curl`, "echo download-unavailable >&2; exit 42");
  const [code, output, error] = await run(script());
  expect(code).toBe(42);
  expect(output).toContain("Codex CLI failed (exit 42)");
  expect(error).toContain("download-unavailable");
  expect(await Bun.file(`${home}/.codex-cli-update-check`).exists()).toBe(false);
});

test("first install inside tmux cannot fall back to prompting on inherited tty stdin", async () => {
  await installed("codex");
  await writeFile(`${home}/installer-binary`, await readFile(binary("codex")));
  await rm(binary("codex"));
  await executable(`${home}/tools/curl`, `cat > "$4" <<'INSTALLER'
set -eu
if [ -t 0 ]; then echo unexpected-tty-stdin >&2; exit 1; fi
mkdir -p "$(dirname "${binary("codex")}")"
cp "$HOME/installer-binary" "${binary("codex")}"
chmod +x "${binary("codex")}"
INSTALLER`);
  await writeFile(`${home}/launch.sh`, script());
  const session = `managed-install-${home.split("/").at(-1)}`;
  const child = Bun.spawn(["tmux", "-L", session, "new-session", "-d", "-s", session, `bash '${home}/launch.sh' > '${home}/output' 2>&1; echo $? > '${home}/exit'; sleep 300`], {
    env: { ...process.env, HOME: home, PATH: `${home}/tools:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  try {
    const deadline = Date.now() + 5_000;
    while (!await Bun.file(`${home}/exit`).exists() && Date.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(`${home}/exit`).exists()).toBe(true);
    expect((await readFile(`${home}/exit`, "utf8")).trim()).toBe("0");
    expect(await readFile(`${home}/output`, "utf8")).toContain("INSTALLED");
  } finally {
    expect(await Bun.spawn(["tmux", "-L", session, "kill-server"], { stdout: "pipe", stderr: "pipe" }).exited).toBe(0);
  }
});
