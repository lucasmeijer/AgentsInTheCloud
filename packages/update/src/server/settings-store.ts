import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import { updateJsonSettings } from "@agents-in-the-cloud/core/json-settings";
import { readReleaseSettings, selectedReleaseChannel, defaultReleaseSource, releaseSourceSchema, type ReleaseSource } from "@agents-in-the-cloud/shared/release-source";
import { Value } from "typebox/value";
import { type UpdateChannel } from "./update-channel.ts";

function settingsPath(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "update.json");
}

export async function readStoredUpdateChannel(): Promise<UpdateChannel | undefined> {
  return selectedReleaseChannel(await readReleaseSettings(settingsPath()));
}

export async function writeStoredUpdateChannel(channel: UpdateChannel): Promise<void> {
  await updateJsonSettings(settingsPath(), settings => {
    if (channel === "custom") {
      settings.releaseSource ??= { ...defaultReleaseSource };
      if (!Value.Check(releaseSourceSchema, settings.releaseSource)) throw new Error("Save a custom source first");
      settings.releaseMode = "custom";
    } else {
      settings.releaseChannel = channel;
      if (settings.releaseSource) settings.releaseMode = "upstream";
    }
  });
}

export async function readStoredReleaseSource(): Promise<ReleaseSource | undefined> {
  return (await readReleaseSettings(settingsPath())).releaseSource;
}
export async function writeStoredReleaseSource(source: ReleaseSource): Promise<void> {
  if (!Value.Check(releaseSourceSchema, source)) throw new Error("Invalid release source");
  await updateJsonSettings(settingsPath(), settings => { settings.releaseSource = source; settings.releaseMode = "custom"; });
}
