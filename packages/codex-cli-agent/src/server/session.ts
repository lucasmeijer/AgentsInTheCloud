import { writeCliSessionFiles, type CliAgentConnection, type CliAgentSession } from "@agents-in-the-cloud/cli-agent/server";
import { shellQuote } from "@agents-in-the-cloud/core";

/** Keep launch config and credentials private, while Codex owns one shared native installation. */
export async function prepareCodexSession(workspaceId: string, session: CliAgentSession, connection: CliAgentConnection): Promise<Record<string, string>> {
  const directory = `${session.directory}/codex`;
  await writeCliSessionFiles(workspaceId, session, {
    "codex/instructions.override": `developer_instructions=${JSON.stringify(connection.instructions)}`,
    "codex/mcp.override": `mcp_servers.agents-in-the-cloud={url=${JSON.stringify(connection.url)},required=true,tool_timeout_sec=3600,http_headers_helper=${JSON.stringify(`cat ${shellQuote(`${directory}/http-headers.json`)}`)}}`,
    "codex/http-headers.json": JSON.stringify({ Authorization: `Bearer ${connection.token}` }),
    "codex/session-start.cjs": `const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const shared = path.join(process.env.HOME, ".codex", "sessions") + "/";
const privateRoot = path.join(__dirname, "sessions") + "/";
if (typeof input.session_id !== "string" || !/^[0-9a-f-]{36}$/.test(input.session_id)) throw new Error("Invalid Codex session ID");
if (input.transcript_path === null) throw new Error("Codex SessionStart did not provide a transcript path");
const root = typeof input.transcript_path === "string" && input.transcript_path.startsWith(privateRoot) ? privateRoot : shared;
if (typeof input.transcript_path !== "string" || !input.transcript_path.startsWith(root) || path.normalize(input.transcript_path) !== input.transcript_path) throw new Error("Invalid Codex transcript path");
const target = path.join(__dirname, "native-session.json");
const temporary = target + "." + process.pid;
fs.writeFileSync(temporary, JSON.stringify({ id: input.session_id, transcript: input.transcript_path.slice(root.length), ...(root === privateRoot ? { private: true } : {}) }), { mode: 0o600 });
fs.renameSync(temporary, target);
`,
  });
  return {};
}
