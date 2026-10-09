import { escapeHtml } from "@agents-in-the-cloud/shared";
import { stream } from "@agents-in-the-cloud/shared/http";
import { agentsInTheCloudThemes, isAgentsInTheCloudTheme, readThemeSetting, writeThemeSetting, type AgentsInTheCloudTheme } from "@agents-in-the-cloud/shared/theme";

export const themeRegionId = "agents-in-the-cloud_theme";

/** Contents of the page's theme region. Its controller applies the theme to the document. */
export function themeRegionHtml(theme: AgentsInTheCloudTheme = readThemeSetting()): string {
  return `<span data-controller="agents-in-the-cloud-theme" data-agents-in-the-cloud-theme-name-value="${escapeHtml(theme)}"></span>`;
}

export async function renderThemeSettings(): Promise<string> {
  const current = readThemeSetting();
  const options = agentsInTheCloudThemes.map(({ id, label }) => `<option value="${id}"${id === current ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  return `<section class="settings-sec settings-sec-inline settings-sec-theme" id="settings-sec-theme"><h2>Theme</h2><form method="post" action="/settings/theme" data-turbo="true" data-controller="settings-autosave" data-action="change->settings-autosave#save submit->settings-autosave#submit"><select class="settings-select popup-select" data-controller="popup-select" name="theme" aria-label="Theme">${options}</select></form></section>`;
}

export async function handleThemeSettingsRequest(request: Request, url: URL, themeChanged: () => void): Promise<Response | undefined> {
  if (url.pathname !== "/settings/theme" || request.method !== "POST") return undefined;
  const theme = (await request.formData()).get("theme");
  if (!isAgentsInTheCloudTheme(theme)) return new Response("Unsupported theme", { status: 400 });
  await writeThemeSetting(theme);
  // Every open page, including this one, applies it through the shell region.
  themeChanged();
  return stream("");
}
