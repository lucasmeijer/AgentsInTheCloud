import { escapeHtml, turboStream, turboStreamResponse, type SettingsContribution } from "@agents-in-the-cloud/shared";
import { isDictationModelId, readDictationModel, dictationModels, writeDictationModel } from "./models.ts";
import { stopTranscriptionServer } from "./realtime.ts";

const sectionId = "settings-sec-dictation";
const settingsPath = "/settings/dictation-model";

async function renderDictationSettings(): Promise<string> {
  const selected = await readDictationModel();
  const options = dictationModels.map((model) =>
    `<option value="${model.id}"${model.id === selected ? " selected" : ""}>${escapeHtml(model.name)} — ${escapeHtml(model.description)}</option>`).join("");
  return `<section class="settings-sec settings-sec-inline settings-sec-dictation" id="${sectionId}">
    <h2>Dictation</h2>
    <form method="post" action="${settingsPath}" data-turbo="true" data-controller="settings-autosave" data-action="change->settings-autosave#save submit->settings-autosave#submit">
      <select class="settings-select popup-select" data-controller="popup-select" name="model" aria-label="Dictation model">${options}</select>
    </form>
  </section>`;
}

export const dictationSettingsContribution: SettingsContribution = {
  id: "dictation",
  label: "Dictation",
  order: 45,
  render: renderDictationSettings,
  async handleAction({ request, url }) {
    if (url.pathname !== settingsPath || request.method !== "POST") return undefined;
    const model = String((await request.formData()).get("model") ?? "");
    if (!isDictationModelId(model)) throw new Error(`unsupported dictation model: ${model}`);
    const changed = model !== await readDictationModel();
    await writeDictationModel(model);
    if (changed) await stopTranscriptionServer();
    return turboStreamResponse(turboStream("replace", sectionId, await renderDictationSettings()));
  },
};
