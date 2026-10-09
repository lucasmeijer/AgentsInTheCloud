import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import { readJsonSettings, updateJsonSettings } from "@agents-in-the-cloud/core/json-settings";
import { readReleaseSettings, releaseSourceSchema, type ReleaseSource } from "@agents-in-the-cloud/shared/release-source";
import { Value } from "typebox/value";
import { updateChannelSchema, type UpdateChannel } from "./update-channel.ts";

function settingsPath(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "update.json");
}

export async function readStoredUpdateChannel(): Promise<UpdateChannel | undefined> {
  // Retain the serialized field in existing update.json files.
  const { releaseChannel: updateChannel } = await readJsonSettings(settingsPath());
  if (updateChannel === undefined) return undefined;
  if (!Value.Check(updateChannelSchema, updateChannel)) throw new Error("Invalid update settings");
  return updateChannel;
}

export async function writeStoredUpdateChannel(channel: UpdateChannel): Promise<void> {
  await updateJsonSettings(settingsPath(), (settings) => { settings.releaseChannel = channel; });
}

export async function readStoredReleaseSource(): Promise<ReleaseSource | undefined> {
  return (await readReleaseSettings(settingsPath())).releaseSource;
}
export async function writeStoredReleaseSource(source: ReleaseSource): Promise<void> {
  if (!Value.Check(releaseSourceSchema, source)) throw new Error("Invalid release source");
  await updateJsonSettings(settingsPath(), settings => { settings.releaseSource = source; });
}
