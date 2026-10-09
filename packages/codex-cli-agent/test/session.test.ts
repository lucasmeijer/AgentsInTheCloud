import { expect, test } from "bun:test";
import { join } from "node:path";

test("Codex keeps session config and MCP credentials private without overriding its shared home", async () => {
  const source = join(import.meta.dir, "../src/server/session.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const cli = await import("@agents-in-the-cloud/cli-agent/server");
    const calls = [];
    mock.module("@agents-in-the-cloud/cli-agent/server", () => ({ ...cli, writeCliSessionFiles: async (...args) => { calls.push(args); } }));
    const { prepareCodexSession } = await import(${JSON.stringify(source)});
    const root = await mkdtemp(join(tmpdir(), "codex-session-"));
    try {
      const mcp = { url: "http://127.0.0.1:2988/mcp", token: "private-bearer-token" };
      const session = { id: "session", directory: root, turnSignalCommand: root + "/signal.sh" };
      const instructions = 'Full guidance "quoted"\\n' + "x".repeat(12000);
      expect(await prepareCodexSession("workspace", session, { ...mcp, instructions })).toEqual({});
      expect(calls).toHaveLength(1);
      const [, , files] = calls[0];
      expect(Bun.TOML.parse(files["codex/instructions.override"]).developer_instructions).toBe(instructions);
      const server = Bun.TOML.parse(files["codex/mcp.override"]).mcp_servers["agents-in-the-cloud"];
      expect(server).toMatchObject({ url: mcp.url, required: true, tool_timeout_sec: 3600 });
      expect(server.http_headers_helper).toContain("http-headers.json");
      expect(files["codex/mcp.override"]).not.toContain(mcp.token);
      expect(JSON.parse(files["codex/http-headers.json"])).toEqual({ Authorization: "Bearer " + mcp.token });
      await mkdir(root + "/codex");
      await writeFile(root + "/codex/session-start.cjs", files["codex/session-start.cjs"]);
      const id = "11111111-2222-3333-4444-555555555555";
      const hook = (path) => Bun.spawn(["node", root + "/codex/session-start.cjs"], { env: { ...process.env, HOME: root }, stdin: new Blob([JSON.stringify({ session_id: id, transcript_path: path })]), stdout: "pipe", stderr: "pipe" });
      const first = hook(root + "/.codex/sessions/2026/01/01/rollout-" + id + ".jsonl");
      expect(await first.exited).toBe(0);
      expect(JSON.parse(await readFile(root + "/codex/native-session.json", "utf8"))).toEqual({ id, transcript: "2026/01/01/rollout-" + id + ".jsonl" });
      const legacy = hook(root + "/codex/sessions/2026/01/01/rollout-" + id + ".jsonl");
      expect(await legacy.exited).toBe(0);
      expect(JSON.parse(await readFile(root + "/codex/native-session.json", "utf8"))).toEqual({ id, transcript: "2026/01/01/rollout-" + id + ".jsonl", private: true });
      const invalid = hook(root + "/.codex/sessions/../../secret");
      expect(await invalid.exited).not.toBe(0);
      expect(await new Response(invalid.stderr).text()).toContain("Invalid Codex transcript path");
    } finally { await rm(root, { recursive: true, force: true }); }
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
