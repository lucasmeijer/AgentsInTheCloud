import { fileURLToPath } from "node:url";
import { writeCliSessionFiles, type CliAgentConnection, type CliAgentSession } from "@agents-in-the-cloud/cli-agent/server";

export function piAgentsInTheCloudExtensionPath(session: CliAgentSession): string {
  return `${session.directory}/pi-agents-in-the-cloud/extension.mjs`;
}

let bundledExtension: Promise<string> | undefined;
function buildExtension(): Promise<string> {
  return bundledExtension ??= (async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../extension/pi-agents-in-the-cloud.ts", import.meta.url))],
      target: "node",
      format: "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!result.success) throw new Error(`Could not bundle the pi-agents-in-the-cloud extension: ${result.logs.map(String).join("\n")}`);
    return await result.outputs[0]!.text();
  })();
}

export async function preparePiSession(workspaceId: string, session: CliAgentSession, connection: CliAgentConnection): Promise<Record<string, string>> {
  const extension = await buildExtension();
  const config = JSON.stringify({ ...connection, turnSignalCommand: session.turnSignalCommand });
  await writeCliSessionFiles(workspaceId, session, {
    "pi-agents-in-the-cloud/extension.mjs": extension,
    "pi-agents-in-the-cloud/config.json": config,
  });
  return {};
}
