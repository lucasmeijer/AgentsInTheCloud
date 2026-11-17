import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import { readJsonSettings, updateJsonSettings } from "@agents-in-the-cloud/core/json-settings";
import { toggleHtml } from "@agents-in-the-cloud/design-system/toggle";
import { turboStream, turboStreamResponse, type SettingsContribution } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

const settingsSchema = Type.Object({ enabled: Type.Optional(Type.Boolean()) });
const sectionId = "settings-sec-prompt-suggestions";
const settingsPath = "/settings/prompt-suggestions";

function settingsFile(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "prompt-suggestions.json");
}

export async function readPromptSuggestionsEnabled(): Promise<boolean> {
  return Value.Parse(settingsSchema, await readJsonSettings(settingsFile())).enabled ?? true;
}

async function renderPromptSuggestionSettings(): Promise<string> {
  const toggle = toggleHtml({
    variant: "button",
    label: "Suggested prompts",
    name: "enabled",
    value: String(await readPromptSuggestionsEnabled()),
    form: { action: settingsPath },
    options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }],
  });
  return `<section class="settings-sec settings-choice-row" id="${sectionId}"><h2>Suggested prompts</h2>${toggle}</section>`;
}

export const promptSuggestionSettingsContribution: SettingsContribution = {
  id: "prompt-suggestions",
  label: "Suggested prompts",
  order: 40,
  render: renderPromptSuggestionSettings,
  async handleAction({ request, url }) {
    if (url.pathname !== settingsPath || request.method !== "POST") return undefined;
    const enabled = String((await request.formData()).get("enabled"));
    if (enabled !== "true" && enabled !== "false") return new Response("Choose on or off", { status: 400 });
    await updateJsonSettings(settingsFile(), (settings) => { settings.enabled = enabled === "true"; });
    return turboStreamResponse(turboStream("replace", sectionId, await renderPromptSuggestionSettings()));
  },
};
