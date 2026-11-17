import { createCliModelSettings, type CliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import { piCliModelUnavailableReason } from "./pi-cli-bridge.ts";
import type { JsonObject } from "@agents-in-the-cloud/core";
import { piModelSetupRequired } from "./auth.ts";

const sharedSettings = createCliModelSettings({
  agentTypeId: "pi", label: "Pi",
  mapThinkingLevel: (level) => level,
  unavailableReason: piCliModelUnavailableReason,
});

async function preparePiModelSettings(parameters: JsonObject = {}): Promise<CliModelSettings> {
  const settings = await sharedSettings.prepare(parameters);
  if (!settings.model) throw piModelSetupRequired();
  return settings;
}

export const piModelSettings = { ...sharedSettings, prepare: preparePiModelSettings };
