import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { resolveWorkspace, startInWorkspace, workspaceExitStatus, workspaceRoot } from "@agents-in-the-cloud/workspace";
import type { CodexNotification } from "./protocol.ts";
import { CodexRpc } from "./rpc.ts";
import { codexVersion } from "./protocol.ts";

/** Stdio stays private: no listening port or raw provider credential in a workspace. */
export async function openCodexTransport(workspaceId: string, home: string, notification: (notification: CodexNotification) => void, failed: (error: Error) => void, mcp: { url: string; token: string }) {
  await resolveWorkspace(workspaceId);
  const executable = `/home/agents-in-the-cloud/.codex-cli/${codexVersion}/node_modules/.bin/codex`;
  const connectionOverride = `mcp_servers.agents-in-the-cloud={url=${JSON.stringify(mcp.url)},required=true,tool_timeout_sec=3600,http_headers={Authorization=${JSON.stringify("Bearer " + mcp.token)}}}`;
  const process = startInWorkspace(workspaceId, { argv: [executable, "-c", 'cli_auth_credentials_store="file"', "-c", connectionOverride, "app-server", "--listen", "stdio://"], user: "agents-in-the-cloud", workdir: workspaceRoot, env: { CODEX_HOME: home }, stdin: true });
  let closing: Promise<void> | undefined;
  const rpc = new CodexRpc(line => process.write(line), notification);
  let stderr = "";
  const stderrDecoder = new TextDecoder();
  const stderrDrain = (async () => {
    for await (const chunk of process.stderr) {
      stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-16000);
    }
    stderr = (stderr + stderrDecoder.decode()).slice(-16000);
  // A failed call also rejects `exited`, which reports it.
  })().catch(() => {});
  let reported = false;
  const report = (error: Error) => {
    rpc.fail(error);
    if (closing || reported) return;
    reported = true;
    failed(error);
  };
  const lines = createInterface({ input: Readable.from(process.stdout), crlfDelay: Infinity });
  const reading = (async () => {
    try { for await (const line of lines) if (line.trim()) rpc.receive(line); }
    catch (error) {
      report(error instanceof Error ? error : new Error(String(error)));
      process.closeStdin();
    }
  })();
  void process.exited.then(async exit => {
    await stderrDrain;
    report(new Error(`Codex app-server exited (${workspaceExitStatus(exit)})${stderr ? `: ${stderr}` : ""}`));
  }, report);
  return { rpc, close() {
    return closing ??= (async () => {
      rpc.fail(new Error("Codex connection closed"));
      process.closeStdin();
      await process.exited.catch(() => {});
      await reading;
      await stderrDrain;
    })();
  } };
}
