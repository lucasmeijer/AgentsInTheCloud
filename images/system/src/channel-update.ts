import { readReleaseSettings, releaseReference } from "../../../packages/shared/src/release-source.ts";

export async function prepareChannelUpdate(settingsPath: string, images: {
  pull: (reference: string) => Promise<void>;
  inspect: (reference: string) => Promise<string>;
}): Promise<string> {
  const reference = releaseReference(await readReleaseSettings(settingsPath), "app");
  // Always refresh the mutable channel tag, even if Docker already has it.
  // Pin the result before dependencies are prepared or the app is stopped.
  await images.pull(reference);
  return await images.inspect(reference);
}
