import { readFileSync } from "node:fs";
import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, isNotFoundError } from "@agents-in-the-cloud/core";
import { updateJsonSettings } from "@agents-in-the-cloud/core/json-settings";
import { parseThemeSettings, type AgentsInTheCloudTheme } from "./theme.ts";

export { agentsInTheCloudThemes, isAgentsInTheCloudTheme, themeAppearance, type AgentsInTheCloudTheme } from "./theme.ts";

function themeSettingPath(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "theme.json");
}

export function readThemeSetting(): AgentsInTheCloudTheme {
  let text: string | undefined;
  try {
    text = readFileSync(themeSettingPath(), "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  return parseThemeSettings(text, process.env.ATELIER_HOST_UID ? "cappuccino" : "nord");
}

export async function writeThemeSetting(theme: AgentsInTheCloudTheme): Promise<void> {
  await updateJsonSettings(themeSettingPath(), (settings) => { settings.theme = theme; });
}
