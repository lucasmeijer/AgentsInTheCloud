import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: bun packages/subagents/scripts/sync-codex-prompts.ts /path/to/openai-codex");
const root = resolve(checkout);
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const paths = ["codex-rs/models-manager/models.json", "codex-rs/core/src/session/multi_agents.rs", "codex-rs/core/src/context/multi_agent_mode_instructions.rs"];
if (git("status", "--porcelain", "--", ...paths)) throw new Error("Upstream prompt sources must be unmodified before importing.");
const nullableText = Type.Union([Type.String(), Type.Null()]);
const roles = Type.Object({ root: nullableText, subagent: nullableText });
const modes = Type.Object({ hint_text: Type.Optional(nullableText), explicit: Type.Optional(nullableText), proactive: Type.Optional(nullableText) });
const catalogue = Value.Parse(Type.Object({ models: Type.Array(Type.Object({
  slug: Type.String(),
  model_messages: Type.Object({ multi_agent: Type.Optional(Type.Union([Type.Null(), Type.Object({
    role: Type.Optional(Type.Union([Type.Null(), roles])),
    mode: Type.Optional(Type.Union([Type.Null(), modes])),
  })])) }),
})) }), await Bun.file(resolve(root, paths[0]!)).json());
const roleSource = await Bun.file(resolve(root, paths[1]!)).text();
const modeSource = await Bun.file(resolve(root, paths[2]!)).text();
function constant(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name}: &str =\\s*(?:r#"([\\s\\S]*?)"#|("(?:[^"\\\\]|\\\\.)*"));`));
  if (!match) throw new Error(`Upstream constant changed: ${name}. Review the resolver before updating the importer.`);
  return match[1] ?? JSON.parse(match[2]!);
}
const snapshot = {
  source: { repository: "https://github.com/openai/codex", commit: git("rev-parse", "HEAD"), paths, license: "Apache-2.0" },
  defaults: {
    root: constant(roleSource, "DEFAULT_MULTI_AGENT_V2_ROOT_AGENT_USAGE_HINT_TEXT"),
    subagent: constant(roleSource, "DEFAULT_MULTI_AGENT_V2_SUBAGENT_USAGE_HINT_TEXT"),
    wait: constant(roleSource, "DEFAULT_MULTI_AGENT_V2_WAIT_AGENT_USAGE_HINT_TEXT"),
    explicit: constant(modeSource, "EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT"),
    proactive: constant(modeSource, "PROACTIVE_MULTI_AGENT_MODE_TEXT"),
  },
  models: Object.fromEntries(catalogue.models.map((model) => [model.slug, model.model_messages.multi_agent ?? {}])),
};
await Bun.write(new URL("../src/server/codex-prompts.json", import.meta.url), JSON.stringify(snapshot, null, 2) + "\n");
console.log(`Imported Codex delegation prompts at ${snapshot.source.commit}`);
