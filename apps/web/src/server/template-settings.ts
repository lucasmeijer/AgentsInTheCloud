import { disclosureHtml } from "@agents-in-the-cloud/design-system/disclosure";
import { invalidArguments } from "@agents-in-the-cloud/core";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { dialogHtml } from "@agents-in-the-cloud/design-system/dialog";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { panelHtml } from "@agents-in-the-cloud/design-system/panel";
import { toggleHtml } from "@agents-in-the-cloud/design-system/toggle";
import { warningBannerHtml } from "@agents-in-the-cloud/design-system/warning-banner";
import { buttonConfirmationHtml } from "@agents-in-the-cloud/design-system/button-confirmation";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { formatWorkspaceTemplateSpec, getWorkspaceTemplateConfiguration, getWorkspaceTemplateSshKnownHosts, listWorkspaceTemplateSshKeys, workspaceTemplateSecretAllowsPath, type WorkspaceTemplateConfiguration, type WorkspaceTemplateSecretSummary } from "@agents-in-the-cloud/workspace-templates";

import { workspaceTemplateSwatchColor } from "./workspace-template-presentation.ts";

export const templateSettingsHostId = "template_settings_host";
export const templateSettingsFrameId = "template_settings_detail";
export type TemplateSettingsSection = "index" | typeof sections[number];
export interface TemplateSettingsLocation { section?: string; editor?: string }
export interface TemplateSettingsReference { workspaceId: string; title: string }

function sectionFor(value?: string): TemplateSettingsSection | undefined {
  if (value === undefined) return undefined;
  if (value === "index") return value;
  const section = sections.find(section => section === value);
  if (section) return section;
  switch (value) {
    case "repository": return "general";
    case "danger": return "index";
    case "ssh-keys": return "ssh";
    case "dockerfile": case "preload-images": case "privileged": return "container";
    default: throw invalidArguments("Unknown template settings section");
  }
}
const sections = ["general", "secrets", "ssh", "environment", "container", "developer"] as const;
const captionButton = (caption: string, attributesHtml: string, variant: "secondary" | "primary" = "secondary") => buttonHtml({ type: "button", variant, content: { kind: "caption", caption }, attributesHtml });
const paragraph = (text: string) => `<p class="template-settings-note">${escapeHtml(text)}</p>`;
const field = (caption: string, name: string, value: string, attributes = "") => `<label class="form-section"><span>${escapeHtml(caption)}</span><input class="text-field" name="${name}" value="${escapeHtml(value)}" ${attributes}></label>`;
const textarea = (caption: string, name: string, value: string, rows: number, attributes = "") => `<label class="form-section"><span>${caption}</span><textarea class="textarea" name="${name}" rows="${rows}" ${attributes}>${escapeHtml(value)}</textarea></label>`;
export function templateSettingsUrl(id: string, section: TemplateSettingsSection, editor?: string): string {
  return `/workspace-templates/${encodeURIComponent(id)}/settings?section=${section}${editor ? `&editor=${encodeURIComponent(editor)}` : ""}`;
}
interface EditorFormOptions {
  section: TemplateSettingsSection;
  saved: boolean;
  editor?: string;
  caption?: string;
  attributesHtml?: string;
  autosave?: boolean;
  available?: boolean;
}
const editorKey = (section: TemplateSettingsSection, editor?: string) => `${section}:${editor ?? ""}`;
function form(id: string, path: string, contents: string, { section, saved, editor, caption = "Save changes", attributesHtml = "", autosave = false, available = true }: EditorFormOptions): string {
  return `<form class="form-stack" method="post" action="/workspace-templates/${encodeURIComponent(id)}${path}" data-template-settings-target="form" data-template-settings-form-key="${escapeHtml(editorKey(section, editor))}"${autosave ? ' data-template-settings-autosave' : ""} data-template-settings-available="${available}"${saved ? ' data-template-settings-saved-form' : ""} data-action="input->template-settings#changed change->template-settings#changed turbo:submit-start->template-settings#submitting turbo:submit-end->template-settings#submitted" ${attributesHtml}>
    ${contents}
    <div class="form-actions" tabindex="-1" data-template-settings-save-actions${autosave ? " hidden" : ""}>${captionButton("Cancel", 'data-action="template-settings#reset"')}${buttonConfirmationHtml({
      type: "submit", variant: "primary", disabled: true,
      content: { kind: "caption", caption }, confirmationLabel: "Changes saved", confirmed: saved,
      attributesHtml: "data-template-settings-save",
    })}</div>
  </form>`;
}
function inlineDisclosure(section: TemplateSettingsSection, editor: string | undefined, label: string, contents: string, open = false, attributesHtml = ""): string {
  return disclosureHtml({ element: { attributesHtml: `data-template-settings-disclosure="${escapeHtml(editorKey(section, editor))}"${attributesHtml ? ` ${attributesHtml}` : ""}` }, summary: { kind: "compact", width: "fit", label: { kind: "text", text: label }, attributesHtml: `data-template-settings-record="${escapeHtml(editorKey(section, editor))}"` }, bodyHtml: `<div class="template-settings-inline-body">${contents}</div>`, open });
}
function removeForm(id: string, path: string, section: TemplateSettingsSection, label: string, consequence: string): string {
  return `<div class="template-settings-remove">${paragraph(consequence)}<form method="post" action="/workspace-templates/${encodeURIComponent(id)}${path}" data-action="turbo:submit-start->template-settings#submitting turbo:submit-end->template-settings#submitted">${destructiveConfirmationHtml({ id: `template_remove_${section}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`, trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: label } }, confirmCaption: label, cancelCaption: "Cancel" })}</form></div>`;
}
function selection(label: string, name: string, value: string, options: { value: string; label: string }[]): string {
  return `<div class="form-section"><span>${label}</span><input type="hidden" name="${name}" value="${value}">${toggleHtml({ variant: "button", label, name, value, options, element: { dataAction: `change->template-settings#toggleChanged` } })}</div>`;
}
function secretEditor(t: WorkspaceTemplateConfiguration, secret?: WorkspaceTemplateSecretSummary, saved = false): string {
  const isNew = !secret;
  const permission = String(secret ? workspaceTemplateSecretAllowsPath(secret) : false);
  const hostAttributes = isNew ? 'data-workspace-template-secret-path-target="host" data-action="input->workspace-template-secret-path#useDefault"' : "";
  const content = `${field("Environment variable", "envName", secret?.envName ?? "", 'required autocomplete="off"')}
    ${field("Allowed host", "hostPattern", secret?.hostPattern ?? "", `required autocomplete="off" placeholder="api.example.com" ${hostAttributes}`)}
    ${field(secret?.configured ? "Replace secret value" : "Secret value", "secretValue", "", `type="password" autocomplete="new-password" data-1p-ignore`)}
    ${paragraph(secret?.configured ? "Leave the value blank to keep the stored secret. Stored values are never shown." : "Agents only see a placeholder. Add the real value here when it’s available.")}
    ${disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Advanced" } }, bodyHtml: `<div class="form-stack">
      ${field("Placeholder", "placeholder", secret?.placeholder ?? "", 'autocomplete="off"')}
      ${paragraph("Leave blank to use an automatically generated placeholder.")}
      ${textarea("Needed for", "annotation", secret?.annotation ?? "", 2)}
      <div class="form-section"><span>Allow substitution in URL paths</span><input type="hidden" name="allowInPath" value="${permission}"${isNew ? ' data-workspace-template-secret-path-target="permission"' : ""}>
      ${toggleHtml({ variant: "button", label: "Allow substitution in URL paths", name: "allowInPath", value: permission, options: [{ value: "false", label: "Disallow" }, { value: "true", label: "Allow" }], element: { dataAction: `${isNew ? "click->workspace-template-secret-path#choose change->workspace-template-secret-path#choose " : ""}change->template-settings#toggleChanged`, data: isNew ? { "workspace-template-secret-path-target": "toggle" } : undefined } })}</div>
      ${paragraph("Allow only if the service needs this secret in its URL path, rather than headers or the request body.")}
    </div>` })}`;
  return `${secret ? paragraph(secret.configured ? "Secret stored" : "No value stored") : ""}${form(t.id, `/secrets${secret ? `/${encodeURIComponent(secret.id)}` : ""}`, content, { section: "secrets", saved, editor: secret?.id ?? "new", caption: isNew ? "Add secret" : "Save changes", attributesHtml: isNew ? 'data-controller="workspace-template-secret-path"' : "" })}${secret ? removeForm(t.id, `/secrets/${encodeURIComponent(secret.id)}/delete`, "secrets", "Delete secret", `Delete ${secret.envName} and its stored value. Requests using it will no longer receive this secret.`) : ""}`;
}

export function templateSettingsErrorHtml(message: string): string {
  return warningBannerHtml({
    title: "Couldn’t save changes", message, role: "alert",
    dismiss: { buttonAttributesHtml: 'data-action="template-settings#dismissError"', label: "Dismiss save error" },
  });
}

export async function renderTemplateSettingsFrame(id: string, location: TemplateSettingsLocation, references: TemplateSettingsReference[], saved = false, submittedPath?: string): Promise<string> {
  const [t, keys, knownHosts] = await Promise.all([getWorkspaceTemplateConfiguration(id), listWorkspaceTemplateSshKeys(id), getWorkspaceTemplateSshKnownHosts(id)]);
  const section = sectionFor(location.section) ?? "index";
  const editor = location.editor ?? (location.section === "privileged" ? "docker" : location.section === "preload-images" ? "images" : location.section === "dockerfile" ? "dockerfile" : undefined);
  if (editor && !["secrets", "ssh", "environment", "container"].includes(section)) throw invalidArguments("This settings section has no record editor");
  if (section === "container" && editor && !["docker", "images", "dockerfile"].includes(editor)) throw invalidArguments("Settings record not found");
  if (editor && editor !== "new" && (section === "secrets" && !t.secrets.some(secret => secret.id === editor) || section === "environment" && !t.environment.some(variable => variable.id === editor) || section === "ssh" && editor !== "known-hosts" && !keys.some(key => key.id === editor))) throw invalidArguments("Settings record not found");
  const savedFor = (value: TemplateSettingsSection, record?: string) => saved && section === value && editor === record;
  const opened = (value: TemplateSettingsSection, record?: string) => section === value && (record === undefined || editor === record);
  const general = form(id, "", `<div class="template-settings-inline-fields">${field("Display name", "name", t.name, 'required autocomplete="off" data-1p-ignore="true"')}${field("Repository", "gitUrl", formatWorkspaceTemplateSpec(t), "required")}</div><label class="template-settings-color"><span>Swatch color</span><input type="hidden" name="swatchColor" value="${escapeHtml(t.swatchColor ?? "")}"><span class="template-settings-color-control"><span class="workspace-template-icon" style="--workspace-template-swatch: ${escapeHtml(t.swatchColor ?? workspaceTemplateSwatchColor(t.id))}" aria-hidden="true"></span><input type="color" name="swatchColorPicker" aria-label="Swatch color" data-template-settings-target="colorPicker" data-default-color="${workspaceTemplateSwatchColor(t.id)}" data-action="input->template-settings#colorChanged change->template-settings#colorChanged"></span></label>`, { section: "general", saved: savedFor("general"), autosave: true });
  const secrets = inlineDisclosure("secrets", undefined, "Secrets your agent may use but not see", `${paragraph("Agents use placeholders. Real values are substituted in requests to allowed hosts. Changes also apply to existing workspaces.")}<div class="template-settings-inline-records">${t.secrets.map(secret => inlineDisclosure("secrets", secret.id, secret.envName, secretEditor(t, secret, savedFor("secrets", secret.id)), opened("secrets", secret.id))).join("")}${inlineDisclosure("secrets", "new", "Add secret", secretEditor(t), opened("secrets", "new"))}</div>`, opened("secrets"));
  const environmentEditor = (variable?: WorkspaceTemplateConfiguration["environment"][number]) => {
    const record = variable?.id ?? "new";
    return `${form(id, `/environment${variable ? `/${encodeURIComponent(variable.id)}` : ""}`, `<div class="template-settings-inline-fields">${field("Name", "name", variable?.name ?? "", 'required autocomplete="off"')}${field("Value", "value", variable?.value ?? "", 'autocomplete="off"')}</div>`, { section: "environment", editor: record, saved: savedFor("environment", record), caption: variable ? "Save changes" : "Add variable" })}${variable ? removeForm(id, `/environment/${encodeURIComponent(variable.id)}/delete`, "environment", "Remove variable", `Remove ${variable.name} from new workspaces. Existing containers stay unchanged.`) : ""}`;
  };
  const environment = inlineDisclosure("environment", undefined, "Environment variables", `${paragraph("Added to new containers. Use Secrets for passwords and API keys.")}<div class="template-settings-inline-records">${t.environment.map(variable => inlineDisclosure("environment", variable.id, variable.name, environmentEditor(variable), opened("environment", variable.id))).join("")}${inlineDisclosure("environment", "new", "Add variable", environmentEditor(), opened("environment", "new"))}</div>`, opened("environment"));
  const keyEditor = (key?: typeof keys[number]) => {
    const record = key?.id ?? "new";
    const fields = form(id, `/ssh-keys${key ? `/${encodeURIComponent(key.id)}` : ""}`, `${field("Name", "name", key?.name ?? "", 'autocomplete="off"')}${key ? "" : textarea("Private key", "privateKey", "", 7, 'required autocomplete="off" spellcheck="false"')}`, { section: "ssh", editor: record, saved: savedFor("ssh", record), caption: key ? "Save changes" : "Add key" });
    if (!key) return fields;
    const copy = buttonConfirmationHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Copy public key", iconHtml: Icons.Copy }, confirmationLabel: "Copied to clipboard", attributesHtml: 'data-action="ssh-public-key-copy#copy"' });
    return `${fields}<div class="template-settings-toolbar" data-controller="ssh-public-key-copy" data-ssh-public-key-copy-url-value="/workspace-templates/${encodeURIComponent(id)}/ssh-keys/${encodeURIComponent(key.id)}/public-key"><span>${escapeHtml(key.keyType)}</span>${copy}<span data-ssh-public-key-copy-target="error" role="status" hidden>Could not copy key</span></div>${removeForm(id, `/ssh-keys/${encodeURIComponent(key.id)}/delete`, "ssh", "Remove key", `Remove SSH key “${key.name || key.keyType}”. Connections relying on it may stop working.`)}`;
  };
  const ssh = inlineDisclosure("ssh", undefined, "SSH private keys your agent may use but not see", `${paragraph("Private keys are encrypted outside workspaces. Changes also apply to existing workspaces.")}<div class="template-settings-inline-records">${keys.map(key => inlineDisclosure("ssh", key.id, key.name || "Unnamed key", keyEditor(key), opened("ssh", key.id))).join("")}${inlineDisclosure("ssh", "new", "Add key", keyEditor(), opened("ssh", "new"))}${inlineDisclosure("ssh", "known-hosts", "Trusted SSH servers", form(id, "/ssh-known-hosts", `${paragraph("GitHub is trusted by default. Only add identities you have verified with the server’s administrator.")}${textarea("Known hosts", "knownHosts", knownHosts, 7, 'spellcheck="false"')}`, { section: "ssh", editor: "known-hosts", saved: savedFor("ssh", "known-hosts") }), opened("ssh", "known-hosts"))}</div>`, opened("ssh"));
  const dockerSupport = form(id, "/privileged", `${selection("Docker support", "privileged", String(t.privileged ?? false), [{ value: "false", label: "Off" }, { value: "true", label: "On" }])}${paragraph("Privileged workspaces can access host devices and data. Enable only for templates and agents you trust.")}`, { section: "container", editor: "docker", saved: savedFor("container", "docker"), autosave: true });
  const images = inlineDisclosure("container", "images", "Preloaded images", form(id, "/preload-images", `${t.privileged ? "" : paragraph("Turn on Docker support to edit preloaded images. Saved references are kept while Docker is off.")}${textarea("Image references, one per line", "preloadImages", (t.preloadImages ?? []).join("\n"), 6, `spellcheck="false"${t.privileged ? "" : " readonly"}`)}`, { section: "container", editor: "images", saved: savedFor("container", "images"), available: Boolean(t.privileged) }), opened("container", "images"));
  const dockerfile = inlineDisclosure("container", "dockerfile", "Custom Dockerfile", form(id, "/dockerfile", `${textarea("Dockerfile override", "dockerfile", t.dockerfile ?? "", 14, 'spellcheck="false" placeholder="FROM agents-in-the-cloud-workspace"')}${paragraph("Leave blank to use the repository Dockerfile or default image. An override must start with FROM agents-in-the-cloud-workspace.")}`, { section: "container", editor: "dockerfile", saved: savedFor("container", "dockerfile") }), opened("container", "dockerfile"));
  const docker = inlineDisclosure("container", undefined, "Docker", `${paragraph("Docker changes apply to new workspaces. Existing containers stay unchanged.")}${dockerSupport}<div class="template-settings-inline-records">${images}${dockerfile}</div>`, opened("container"));
  const developer = inlineDisclosure("developer", undefined, "Developer settings", form(id, "/seed-config", `${selection("Atelier-in-Atelier seeding", "seedConfigEnabled", String(t.seedConfigEnabled ?? false), [{ value: "false", label: "Off" }, { value: "true", label: "On" }])}${paragraph("Allows the repository manifest to copy provider credentials and template configuration into new workspaces. Enable only for repositories and agents you trust.")}${paragraph("Disabling this does not remove credentials already copied into existing workspaces.")}`, { section: "developer", saved: savedFor("developer") }), opened("developer"), 'hidden data-template-settings-target="developer"');
  const deleteLabel = references.length ? `Delete template — delete ${references.length === 1 ? `workspace “${references[0]!.title}”` : `${references.length} workspaces`} first. This template is still in use.` : "Delete template";
  const deletion = `<form method="post" action="/workspace-templates/${encodeURIComponent(id)}/delete" data-action="turbo:submit-start->template-settings#submitting turbo:submit-end->template-settings#submitted">${destructiveConfirmationHtml({ id: "template_settings_delete", trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Trash, label: deleteLabel }, disabled: references.length > 0, attributesHtml: 'data-template-settings-record="index:delete"' }, confirmCaption: "Delete template", cancelCaption: "Cancel" })}</form>`;
  const header = `<h1 class="panel__title" id="template_settings_title">${Icons.Settings}<span>Template settings · ${escapeHtml(t.name)}</span></h1>${deletion}${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Close template settings" }, attributesHtml: 'data-action="template-settings#close"' })}`;
  const body = `<div class="template-settings-content template-settings-inline" data-template-settings-target="content" data-template-settings-location="${escapeHtml(templateSettingsUrl(id, section, editor))}"${section !== "index" || location.section === "danger" ? ` data-template-settings-focus="${escapeHtml(editorKey(section, location.section === "danger" ? "delete" : editor))}"` : ""}${submittedPath ? ` data-template-settings-submitted-path="${escapeHtml(submittedPath)}"` : ""}>
    <div id="template_settings_error"></div><div id="template_settings_request_error" hidden>${templateSettingsErrorHtml("Please try again. Your unsaved changes are still here.")}</div>
    ${general}<div class="template-settings-inline-disclosures">${secrets}${ssh}${environment}${docker}${developer}</div>
  </div>`;
  return `<turbo-frame id="${templateSettingsFrameId}" data-template-settings-target="frame">${panelHtml({ element: { tag: "section", attributesHtml: 'aria-label="Template settings"' }, headerHtml: header, bodyHtml: body, bodyLayout: "full-bleed", bodyOverflow: "scroll" })}</turbo-frame>`;
}

export async function renderTemplateSettings(id: string, location: TemplateSettingsLocation, references: TemplateSettingsReference[]): Promise<string> {
  const frame = await renderTemplateSettingsFrame(id, location, references);
  const guard = dialogHtml({ element: { id: "template_settings_discard", actions: "cancel->template-settings#stay", attributesHtml: 'data-template-settings-target="discard"' }, iconHtml: Icons.Settings, titleCaption: "Discard unsaved changes?", bodyHtml: paragraph("Your changes haven’t been saved."), omitCancelButton: true, footerHtml: `${captionButton("Stay", 'data-action="template-settings#stay"')}${captionButton("Discard changes", 'data-action="template-settings#discard"', "primary")}` });
  return `<div id="${templateSettingsHostId}" class="template-settings-host" data-controller="template-settings" data-action="turbo:frame-missing->template-settings#frameMissing keydown->template-settings#keydown keydown@window->template-settings#developerKey keyup@window->template-settings#developerKey blur@window->template-settings#developerKey">
    ${frame}${guard}
  </div>`;
}
