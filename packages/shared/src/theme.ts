import { Type } from "typebox";
import { Value } from "typebox/value";

export const agentsInTheCloudThemes = [
  { id: "daylight", label: "Daylight", appearance: "light" },
  { id: "cappuccino", label: "Cappuccino", appearance: "dark" },
  { id: "tokyo-night", label: "Tokyo Night", appearance: "dark" },
  { id: "midnight", label: "Midnight", appearance: "dark" },
  { id: "nord", label: "Nord", appearance: "dark" },
] as const;

export type AgentsInTheCloudTheme = (typeof agentsInTheCloudThemes)[number]["id"];

export function isAgentsInTheCloudTheme(value: unknown): value is AgentsInTheCloudTheme {
  return agentsInTheCloudThemes.some((theme) => theme.id === value);
}

export function themeAppearance(theme: AgentsInTheCloudTheme): "light" | "dark" {
  return agentsInTheCloudThemes.find(({ id }) => id === theme)!.appearance;
}

const themeSettingsSchema = Type.Object({ theme: Type.Optional(Type.String()) });

export function parseThemeSettings(text: string | undefined, fallback: AgentsInTheCloudTheme): AgentsInTheCloudTheme {
  const settings: unknown = text === undefined ? {} : JSON.parse(text);
  if (!Value.Check(themeSettingsSchema, settings)) throw new Error("Invalid theme settings");
  return isAgentsInTheCloudTheme(settings.theme) ? settings.theme : fallback;
}
