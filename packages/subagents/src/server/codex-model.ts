import upstream from "./codex-prompts.json";

const modelIds = Object.keys(upstream.models).sort((a, b) => b.length - a.length || a.localeCompare(b));
const namedFamilies = modelIds.flatMap((id) => {
  const match = /^gpt-[\d.]+-(.+)$/.exec(id);
  return match ? [{ id, name: match[1]! }] : [];
});

export function codexModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const id = modelId.toLowerCase();
  const exact = modelIds.find((candidate) => candidate === id);
  if (exact) return exact;
  const contained = modelIds.find((candidate) => id.includes(candidate));
  if (contained) return contained;
  if (id.includes("gpt")) return namedFamilies.find((family) => id.includes(family.name))?.id;
  return undefined;
}
