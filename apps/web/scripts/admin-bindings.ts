import { getAgentsInTheCloudRuntimeContext, isJsonObject } from "@agents-in-the-cloud/core";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createAdminStore, publicToken } from "../src/server/admin/store.ts";

export async function adminBindingsCommand(args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { "data-dir": { type: "string" }, file: { type: "string" } } });
  const [command, id] = positionals;
  if (positionals.length > (command === "revoke" ? 2 : 1)) throw new Error("Unexpected arguments");
  const store = createAdminStore(join(values["data-dir"] ?? getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "admin-bindings.json"));
  switch (command) {
    case "show": { const config = await store.read(); return { bindings: config.bindings, tokens: config.tokens.map(publicToken) }; }
    case "configure": {
      if (!values.file) throw new Error("configure requires --file with JSON { bindings: [...] }; app restart required");
      const input = await Bun.file(values.file).json();
      if (!isJsonObject(input) || Object.keys(input).length !== 1 || !("bindings" in input)) throw new Error("Expected { bindings: [...] }");
      return store.setBindings(input.bindings);
    }
    case "issue": {
      if (!values.file) throw new Error("issue requires --file with JSON { name, scopes, expiresAt? }");
      return store.issue(await Bun.file(values.file).json());
    }
    case "revoke": {
      if (!id) throw new Error("revoke requires a token ID");
      if (!await store.revoke(id)) throw new Error("Token not found");
      return { revoked: true };
    }
    default: throw new Error("Usage: bun apps/web/scripts/admin-bindings.ts show|configure|issue|revoke [token-id] [--file INPUT.json] [--data-dir PATH]. Configure/issue take JSON files. Issue prints the bearer secret once; capture it securely.");
  }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await adminBindingsCommand(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Admin configuration failed"); process.exitCode = 1; }
}
