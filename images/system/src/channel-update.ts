import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

// The app owns these persisted settings. System reads them independently so recovery
// never requires a functioning app or a second, potentially stale channel setting.
// The app calls this Update channel; keep the existing persisted field spelling.
// appRepository is where the app's checkout publishes images, so forks update from their own.
const settingsSchema = Type.Object({
  releaseChannel: Type.Optional(Type.Union([Type.Literal("stable"), Type.Literal("latest")])),
  appRepository: Type.Optional(Type.String({ pattern: "^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$" })),
});
const upstreamAppRepository = "ghcr.io/lucasmeijer/agents-in-the-cloud";

export async function prepareChannelUpdate(settingsPath: string, images: {
  pull: (reference: string) => Promise<void>;
  inspect: (reference: string) => Promise<string>;
}): Promise<string> {
  const text = await readFile(settingsPath, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  const settings: unknown = text === undefined ? {} : JSON.parse(text);
  if (!Value.Check(settingsSchema, settings)) throw new Error("Invalid update settings");
  const updateChannel = settings.releaseChannel ?? "latest";
  const reference = `${settings.appRepository ?? upstreamAppRepository}:${updateChannel}`;
  // Always refresh the mutable channel tag, even if Docker already has it.
  // Pin the result before dependencies are prepared or the app is stopped.
  await images.pull(reference);
  return await images.inspect(reference);
}
