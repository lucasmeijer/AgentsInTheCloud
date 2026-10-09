import { globalWorkspaceSettingsErrorId, globalWorkspaceSettingsFrameId, globalWorkspaceSettingsPath, globalWorkspaceSettingsUrl, renderGlobalWorkspaceSettingsFrame, renderTemplateSettings, renderTemplateSettingsFrame, templateSettingsErrorHtml, templateSettingsErrorId, templateSettingsFrameId, templateSettingsHostId, templateSettingsUrl, type TemplateSettingsLocation, type TemplateSettingsSection, type TemplateSettingsReference } from "./template-settings.ts";
import { AgentsInTheCloudCoreError, invalidArguments, readJsonObject, requestAcceptsJson, type JsonObject } from "@agents-in-the-cloud/core";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { dialogHtml } from "@agents-in-the-cloud/design-system/dialog";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import {
  addWorkspaceTemplate, createWorkspaceTemplateEnvironmentVariable,
  createWorkspaceTemplateSecret,
  createWorkspaceTemplateSshKey,
  deleteWorkspaceTemplate, deleteWorkspaceTemplateEnvironmentVariable, deleteWorkspaceTemplateSecret, deleteWorkspaceTemplateSshKey, deriveWorkspaceTemplateSshPublicKey,
  getConfiguration, getWorkspaceTemplateConfiguration, getWorkspaceTemplateSshKnownHosts, globalWorkspaceConfiguration, isGlobalScope,
  listWorkspaceTemplates, parseWorkspaceTemplateSpec, renameWorkspaceTemplateSshKey,
  workspaceTemplateSecretPathPermissionSchema,
  setWorkspaceTemplateDockerfile, setWorkspaceTemplatePreloadImages, setWorkspaceTemplatePrivileged, setWorkspaceTemplateSeedConfigEnabled,
  setWorkspaceTemplateSshKnownHosts,
  updateWorkspaceTemplate,
  updateWorkspaceTemplateEnvironmentVariable, updateWorkspaceTemplateSecret,
  type ConfigurationScope, type WorkspaceTemplateEnvironmentVariable, type WorkspaceTemplateSecretInput, type WorkspaceTemplateSecretSummary, type WorkspaceTemplateSshKeySummary, type WorkspaceTemplateSummary,
} from "@agents-in-the-cloud/workspace-templates";
import { shouldSearchGitHubRepositories, turboStreamResponse } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { GitHubRepositorySearchRateLimitError, renderGitHubRepositorySearchMenu, renderGitHubRepositorySearchRateLimitMenu, searchGitHubRepositories } from "./github-repo-search.ts";
import { jsonResponse, matchRoute, replace, response, textResponse, update, wantsStream } from "@agents-in-the-cloud/shared/http";

const jsonStringSchema = Type.String();
const jsonBooleanSchema = Type.Boolean();

export type WorkspaceTemplateEditorOptions =
  | { kind: "settings"; workspaceTemplateId: string; section: string | undefined; editor?: string }
  | { kind: "new" };

export interface WorkspaceTemplateRoutes {
  handle(request: Request, url: URL): Promise<Response | undefined>;
  byReference(reference: string): Promise<WorkspaceTemplateSummary>;
  settingsFrame(workspaceTemplateId: string, location: TemplateSettingsLocation): Promise<string>;
  editorHtml(options: WorkspaceTemplateEditorOptions): Promise<string>;
}

export function createWorkspaceTemplateRoutes(deps: {
  referencingWorkspaces(workspaceTemplateId: string): TemplateSettingsReference[];
  invalidatePresentation(): void;
  createAgentWorkspace(workspaceTemplate: WorkspaceTemplateSummary, request: Request): Promise<Response>;
}): WorkspaceTemplateRoutes {
  function newWorkspaceTemplateEditorBody(): string {
    const cancelButton = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Cancel" }, attributesHtml: 'data-action="dialog#close"' });
    const addButton = buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Add template" }, attributesHtml: 'data-turbo-submits-with="Adding…"' });
    const searchButton = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Search GitHub" }, attributesHtml: 'data-action="workspace-template-github-search#search"' });
    return `<div class="workspace-template-editor-body"><form class="workspace-template-editor-new-form" aria-label="Add template" method="post" action="/workspace-templates" data-turbo="true" data-action="turbo:submit-end->dialog#submitted"><div><p>Save a remote URL, local path, or search for a GitHub repository.</p><div data-controller="workspace-template-github-search" data-workspace-template-github-search-url-value="/workspace-templates/github-search"><div class="workspace-template-github-search-field"><input class="text-field" name="gitUrl" placeholder="github.com/org/repo, or /path/to/repo#branch" required autofocus data-workspace-template-github-search-target="input" data-action="keydown->workspace-template-github-search#keydown input->workspace-template-github-search#input">${searchButton}</div><div class="floating-surface autocomplete-popover workspace-template-github-results" data-workspace-template-github-search-target="menu" hidden></div></div></div><footer>${cancelButton}${addButton}</footer></form></div>`;
  }

  async function workspaceTemplateEditorHtml(options: WorkspaceTemplateEditorOptions): Promise<string> {
    if (options.kind === "settings") return renderTemplateSettings(options.workspaceTemplateId, options, deps.referencingWorkspaces(options.workspaceTemplateId));
    return dialogHtml({
      element: { id: "workspace-template-editor-modal", attributesHtml: "data-dialog-auto-show" },
      iconHtml: Icons.Plus,
      titleCaption: "Add a template",
      bodyHtml: newWorkspaceTemplateEditorBody(),
      bodyLayout: "full-bleed",
      closeLabel: "Close add a template",
    });
  }

  async function workspaceTemplateById(id: string): Promise<WorkspaceTemplateSummary> {
    const { workspaceTemplates } = await listWorkspaceTemplates();
    const workspaceTemplate = workspaceTemplates.find((candidate) => candidate.id === id);
    if (!workspaceTemplate) throw new AgentsInTheCloudCoreError("workspace_template_not_found", `template not found: ${id}`);
    return workspaceTemplate;
  }

  function jsonString(body: JsonObject, field: string): string {
    const value = body[field];
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${field} is required`);
    return value;
  }

  function requiredJsonString(body: JsonObject, field: string): string {
    const value = jsonString(body, field);
    if (!value.trim()) throw invalidArguments(`${field} is required`);
    return value;
  }

  function optionalJsonString(body: JsonObject, field: string): string | undefined {
    const value = body[field];
    if (value === undefined) return undefined;
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${field} must be a string`);
    return value;
  }

  async function workspaceTemplateDetailEndpoint(workspaceTemplateId: string): Promise<Response> {
    return jsonResponse({ workspaceTemplate: await getWorkspaceTemplateConfiguration(workspaceTemplateId) });
  }

  async function createWorkspaceTemplateEndpoint(request: Request, url: URL): Promise<Response> {
    const json = requestAcceptsJson(request);
    const gitUrl = json
      ? requiredJsonString(await readJsonObject(request), "gitUrl")
      : String((await request.formData()).get("gitUrl") ?? "");
    let workspaceTemplate: WorkspaceTemplateSummary;
    try {
      workspaceTemplate = (await addWorkspaceTemplate(gitUrl)).workspaceTemplate;
    } catch (error) {
      if (!(error instanceof AgentsInTheCloudCoreError && error.code === "workspace_template_exists")) throw error;
      const specification = parseWorkspaceTemplateSpec(gitUrl);
      const workspaceTemplates = (await listWorkspaceTemplates()).workspaceTemplates;
      workspaceTemplate = workspaceTemplates.find((candidate) => candidate.gitUrl === specification.gitUrl && candidate.branch === specification.branch)!;
    }
    deps.invalidatePresentation();
    if (json) return jsonResponse({ workspaceTemplate });
    // Adding a template returns to the template picker, where the new template is selected.
    if (wantsStream(request)) return turboStreamResponse(replace("workspace-template-editor-modal", '<div id="workspace-template-editor-modal"></div>'));
    return Response.redirect(new URL("/", url).toString(), 303);
  }

  async function updateWorkspaceTemplateEndpoint(workspaceTemplateId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    let name: string;
    let spec: string;
    let swatchColor: string | undefined;
    if (json) {
      const body = await readJsonObject(request);
      name = requiredJsonString(body, "name");
      spec = requiredJsonString(body, "gitUrl");
      swatchColor = optionalJsonString(body, "swatchColor");
    } else {
      const formData = await request.formData();
      name = String(formData.get("name") ?? "");
      spec = String(formData.get("gitUrl") ?? "");
      if (formData.has("swatchColor")) swatchColor = String(formData.get("swatchColor"));
    }
    const { workspaceTemplate } = await updateWorkspaceTemplate(workspaceTemplateId, { name, spec, swatchColor });
    return workspaceTemplateSettingsResponse(request, { workspaceTemplate });
  }

  /** Refresh workspace warnings except for the future-only image preload list. */
  async function workspaceTemplateSettingsResponse(request: Request, result: { workspaceTemplate: WorkspaceTemplateSummary }): Promise<Response> {
    const url = new URL(request.url);
    const concern = url.pathname.split("/")[3];
    if (concern !== "preload-images") deps.invalidatePresentation();
    if (requestAcceptsJson(request)) return jsonResponse(result);
    const workspaceTemplateId = decodeURIComponent(url.pathname.split("/")[2]!);
    const section: TemplateSettingsSection = concern === "seed-config" ? "developer" : concern === "privileged" || concern === "dockerfile" || concern === "preload-images" ? "container" : "general";
    const record = concern === "privileged" ? "docker" : concern === "preload-images" ? "images" : concern === "dockerfile" ? "dockerfile" : undefined;
    return await settingsPageResponse(request, workspaceTemplateId, section, record, false);
  }

  type ConfigurationResult = { secret: WorkspaceTemplateSecretSummary; deleted?: true } | { environmentVariable: WorkspaceTemplateEnvironmentVariable; deleted?: true } | { key: WorkspaceTemplateSshKeySummary } | { knownHosts: string };

  /**
   * Secrets, SSH keys and Environment variables re-render whichever settings page edited them.
   * Save/create remains in the record's editor; deletion returns to the list because that editor no longer exists.
   */
  async function configurationSettingsResponse(request: Request, scope: ConfigurationScope, name: "secrets" | "ssh" | "environment", record: string, result: ConfigurationResult): Promise<Response> {
    deps.invalidatePresentation();
    if (requestAcceptsJson(request)) return jsonResponse(result);
    const url = new URL(request.url);
    const deleted = url.pathname.endsWith("/delete");
    const section: TemplateSettingsSection = isGlobalScope(scope) ? `global-${name}` : name;
    const editor = deleted ? undefined : record;
    const workspaceTemplateId = editedTemplateId(scope, url);
    if (workspaceTemplateId) return await settingsPageResponse(request, workspaceTemplateId, section, editor, deleted);
    if (!wantsStream(request)) return Response.redirect(new URL(globalWorkspaceSettingsUrl, request.url).toString(), 303);
    return turboStreamResponse(replace(globalWorkspaceSettingsFrameId, await renderGlobalWorkspaceSettingsFrame({ section, editor }, !deleted, url.pathname)));
  }

  /** The template whose settings page made the change; global settings edited from Settings have none. */
  function editedTemplateId(scope: ConfigurationScope, url: URL): string | undefined {
    return isGlobalScope(scope) ? url.searchParams.get("workspaceTemplate") ?? undefined : scope;
  }

  async function settingsPageResponse(request: Request, workspaceTemplateId: string, section: TemplateSettingsSection, editor: string | undefined, deleted: boolean): Promise<Response> {
    if (!wantsStream(request)) return Response.redirect(new URL(templateSettingsUrl(workspaceTemplateId, section, editor), request.url).toString(), 303);
    const frame = await renderTemplateSettingsFrame(workspaceTemplateId, { section, editor }, deps.referencingWorkspaces(workspaceTemplateId), !deleted, new URL(request.url).pathname);
    return turboStreamResponse(replace(templateSettingsFrameId, frame));
  }

  async function readBooleanSetting(request: Request, name: "privileged" | "seedConfigEnabled"): Promise<boolean> {
    if (requestAcceptsJson(request)) {
      const value = (await readJsonObject(request))[name];
      if (!Value.Check(jsonBooleanSchema, value)) throw invalidArguments(`${name} must be a boolean`);
      return value;
    }
    const value = (await request.formData()).get(name);
    if (value !== "true" && value !== "false") throw invalidArguments(`${name} must be true or false`);
    return value === "true";
  }

  async function updateWorkspaceTemplatePrivilegeEndpoint(workspaceTemplateId: string, request: Request): Promise<Response> {
    return workspaceTemplateSettingsResponse(request, await setWorkspaceTemplatePrivileged(workspaceTemplateId, await readBooleanSetting(request, "privileged")));
  }

  async function updateWorkspaceTemplateSeedConfigEndpoint(workspaceTemplateId: string, request: Request): Promise<Response> {
    return workspaceTemplateSettingsResponse(request, await setWorkspaceTemplateSeedConfigEnabled(workspaceTemplateId, await readBooleanSetting(request, "seedConfigEnabled")));
  }

  async function updateWorkspaceTemplateDockerfileEndpoint(workspaceTemplateId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const dockerfile = json ? jsonString(await readJsonObject(request), "dockerfile") : String((await request.formData()).get("dockerfile") ?? "");
    const result = await setWorkspaceTemplateDockerfile(workspaceTemplateId, dockerfile);
    return workspaceTemplateSettingsResponse(request, result);
  }

  async function updateWorkspaceTemplatePreloadImagesEndpoint(workspaceTemplateId: string, request: Request): Promise<Response> {
    let images: string[];
    if (requestAcceptsJson(request)) {
      const body = await readJsonObject(request);
      if (!Value.Check(Type.Array(Type.String()), body.preloadImages)) throw invalidArguments("preloadImages must be an array of image references");
      images = body.preloadImages;
    } else {
      const form = await request.formData();
      images = String(form.get("preloadImages") ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
    const result = await setWorkspaceTemplatePreloadImages(workspaceTemplateId, images);
    return workspaceTemplateSettingsResponse(request, result);
  }

  async function workspaceTemplateEnvironmentVariableValues(request: Request): Promise<{ name: string; value: string }> {
    if (!requestAcceptsJson(request)) {
      const formData = await request.formData();
      return { name: String(formData.get("name") ?? ""), value: String(formData.get("value") ?? "") };
    }
    const body = await readJsonObject(request);
    return { name: requiredJsonString(body, "name"), value: jsonString(body, "value") };
  }

  async function createEnvironmentVariableEndpoint(scope: ConfigurationScope, request: Request): Promise<Response> {
    const environmentVariable = await createWorkspaceTemplateEnvironmentVariable(scope, await workspaceTemplateEnvironmentVariableValues(request));
    return configurationSettingsResponse(request, scope, "environment", environmentVariable.id, { environmentVariable });
  }

  async function updateEnvironmentVariableEndpoint(scope: ConfigurationScope, variableId: string, request: Request): Promise<Response> {
    const environmentVariable = await updateWorkspaceTemplateEnvironmentVariable(scope, variableId, await workspaceTemplateEnvironmentVariableValues(request));
    return configurationSettingsResponse(request, scope, "environment", environmentVariable.id, { environmentVariable });
  }

  async function deleteEnvironmentVariableEndpoint(scope: ConfigurationScope, variableId: string, request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) await readJsonObject(request);
    const environmentVariable = await deleteWorkspaceTemplateEnvironmentVariable(scope, variableId);
    return configurationSettingsResponse(request, scope, "environment", environmentVariable.id, { deleted: true, environmentVariable });
  }

  async function workspaceTemplateSecretValues(request: Request): Promise<WorkspaceTemplateSecretInput> {
    if (!requestAcceptsJson(request)) {
      const formData = await request.formData();
      const pathPermission = formData.get("allowInPath") ?? undefined;
      if (pathPermission !== undefined && !["true", "false"].includes(String(pathPermission))) throw invalidArguments("Invalid URL path permission");
      return {
        allowInPath: pathPermission === undefined ? undefined : pathPermission === "true",
        envName: String(formData.get("envName") ?? ""),
        hostPattern: String(formData.get("hostPattern") ?? ""),
        placeholder: String(formData.get("placeholder") ?? ""),
        secretValue: String(formData.get("secretValue") ?? "") || undefined,
        annotation: String(formData.get("annotation") ?? ""),
      };
    }
    const body = await readJsonObject(request);
    const allowInPath = body.allowInPath;
    if (allowInPath !== undefined && !Value.Check(workspaceTemplateSecretPathPermissionSchema, allowInPath)) throw invalidArguments("allowInPath must be a boolean");
    return {
      envName: requiredJsonString(body, "envName"),
      hostPattern: requiredJsonString(body, "hostPattern"),
      placeholder: optionalJsonString(body, "placeholder"),
      secretValue: optionalJsonString(body, "secretValue"),
      annotation: optionalJsonString(body, "annotation"),
      allowInPath,
    };
  }

  async function createSecretEndpoint(scope: ConfigurationScope, request: Request): Promise<Response> {
    const secret = await createWorkspaceTemplateSecret(scope, await workspaceTemplateSecretValues(request));
    return configurationSettingsResponse(request, scope, "secrets", secret.id, { secret });
  }

  async function updateSecretEndpoint(scope: ConfigurationScope, secretId: string, request: Request): Promise<Response> {
    const secret = await updateWorkspaceTemplateSecret(scope, secretId, await workspaceTemplateSecretValues(request));
    return configurationSettingsResponse(request, scope, "secrets", secret.id, { secret });
  }

  async function deleteSecretEndpoint(scope: ConfigurationScope, secretId: string, request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) await readJsonObject(request);
    const secret = await deleteWorkspaceTemplateSecret(scope, secretId);
    return configurationSettingsResponse(request, scope, "secrets", secret.id, { deleted: true, secret });
  }

  async function updateSshKnownHostsEndpoint(scope: ConfigurationScope, request: Request): Promise<Response> {
    const input = requestAcceptsJson(request) ? jsonString(await readJsonObject(request), "knownHosts") : String((await request.formData()).get("knownHosts") ?? "");
    const knownHosts = await setWorkspaceTemplateSshKnownHosts(scope, input);
    return configurationSettingsResponse(request, scope, "ssh", "known-hosts", { knownHosts });
  }

  async function createSshKeyFromForm(scope: ConfigurationScope, request: Request): Promise<Response> {
    const formData = await request.formData();
    const key = await createWorkspaceTemplateSshKey(scope, String(formData.get("privateKey") ?? ""), undefined, undefined, String(formData.get("name") ?? ""));
    return configurationSettingsResponse(request, scope, "ssh", key.id, { key });
  }

  async function renameSshKeyEndpoint(scope: ConfigurationScope, keyId: string, request: Request): Promise<Response> {
    const name = requestAcceptsJson(request) ? jsonString(await readJsonObject(request), "name") : String((await request.formData()).get("name") ?? "");
    const key = await renameWorkspaceTemplateSshKey(scope, keyId, name);
    return configurationSettingsResponse(request, scope, "ssh", key.id, { key });
  }

  async function deleteSshKeyFromForm(scope: ConfigurationScope, keyId: string, request: Request): Promise<Response> {
    const key = await deleteWorkspaceTemplateSshKey(scope, keyId);
    return configurationSettingsResponse(request, scope, "ssh", key.id, { key });
  }

  /** Secrets, SSH keys and Environment variables for a template or for all workspaces share one set of endpoints. */
  async function handleConfigurationRoute(request: Request, url: URL): Promise<Response | undefined> {
    const match = url.pathname.match(/^\/(?:workspace-templates\/([^/]+)|global-workspace-settings)\/(secrets|environment|ssh-keys|ssh-known-hosts)(?:\/([^/]+))?(?:\/(delete|public-key))?$/);
    if (!match) return undefined;
    const [, workspaceTemplateId, concern, recordId, action] = match;
    const scope: ConfigurationScope = workspaceTemplateId === undefined ? globalWorkspaceConfiguration : decodeURIComponent(workspaceTemplateId);
    const record = recordId === undefined ? undefined : decodeURIComponent(recordId);
    const post = request.method === "POST";
    switch (concern) {
      case "secrets":
        if (post && !record) return await createSecretEndpoint(scope, request);
        if (post && record && !action) return await updateSecretEndpoint(scope, record, request);
        if (post && record && action === "delete") return await deleteSecretEndpoint(scope, record, request);
        return undefined;
      case "environment":
        if (post && !record) return await createEnvironmentVariableEndpoint(scope, request);
        if (post && record && !action) return await updateEnvironmentVariableEndpoint(scope, record, request);
        if (post && record && action === "delete") return await deleteEnvironmentVariableEndpoint(scope, record, request);
        return undefined;
      case "ssh-keys":
        if (post && !record) return await createSshKeyFromForm(scope, request);
        if (request.method === "GET" && record && action === "public-key") return textResponse(await deriveWorkspaceTemplateSshPublicKey(scope, record));
        if (post && record && !action) return await renameSshKeyEndpoint(scope, record, request);
        if (post && record && action === "delete") return await deleteSshKeyFromForm(scope, record, request);
        return undefined;
      case "ssh-known-hosts":
        if (record) return undefined;
        if (request.method === "GET" && requestAcceptsJson(request)) return jsonResponse({ knownHosts: await getWorkspaceTemplateSshKnownHosts(scope) });
        if (post) return await updateSshKnownHostsEndpoint(scope, request);
    }
    return undefined;
  }

  async function deleteWorkspaceTemplateEndpoint(workspaceTemplateId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const workspaceTemplate = await workspaceTemplateById(workspaceTemplateId);
    if (json) await readJsonObject(request);
    const references = deps.referencingWorkspaces(workspaceTemplateId);
    if (references.length > 0) {
      if (json) return jsonResponse({
        deleted: false,
        blocked: true,
        references,
      });
      return turboStreamResponse(update(templateSettingsErrorId, templateSettingsErrorHtml(`Delete ${references.length} workspaces first. This template is still in use.`)), { status: 422 });
    }
    await deleteWorkspaceTemplate(workspaceTemplateId);
    deps.invalidatePresentation();
    if (json) return jsonResponse({ deleted: true, blocked: false, workspaceTemplate });
    return wantsStream(request) ? turboStreamResponse(replace(templateSettingsHostId, `<div id="${templateSettingsHostId}"></div>`)) : Response.redirect(new URL("/", request.url).toString(), 303);
  }

  async function githubRepositorySearchEndpoint(url: URL): Promise<Response> {
    const query = url.searchParams.get("q") ?? "";
    if (!shouldSearchGitHubRepositories(query)) return response("");
    try {
      return response(renderGitHubRepositorySearchMenu(await searchGitHubRepositories(query)));
    } catch (error) {
      if (error instanceof GitHubRepositorySearchRateLimitError) return response(renderGitHubRepositorySearchRateLimitMenu(error), { status: 429 });
      throw error;
    }
  }

  async function byReference(reference: string): Promise<WorkspaceTemplateSummary> {
    const { workspaceTemplates } = await listWorkspaceTemplates();
    const byId = workspaceTemplates.find((workspaceTemplate) => workspaceTemplate.id === reference);
    if (byId) return byId;
    const byName = workspaceTemplates.filter((workspaceTemplate) => workspaceTemplate.name === reference);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw invalidArguments(`template name is ambiguous: ${reference}`);
    throw new AgentsInTheCloudCoreError("workspace_template_not_found", `template not found: ${reference}`);
  }

  async function handleRoute(request: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname === "/workspace-templates" && request.method === "GET" && requestAcceptsJson(request)) return jsonResponse(await listWorkspaceTemplates());
    if (url.pathname === "/workspace-templates" && request.method === "POST") return await createWorkspaceTemplateEndpoint(request, url);
    if (url.pathname === "/workspace-templates/github-search" && request.method === "GET") return await githubRepositorySearchEndpoint(url);
    if (url.pathname === globalWorkspaceSettingsPath && request.method === "GET" && requestAcceptsJson(request)) return jsonResponse({ globalWorkspaceSettings: await getConfiguration(globalWorkspaceConfiguration) });
    const configurationResponse = await handleConfigurationRoute(request, url);
    if (configurationResponse) return configurationResponse;

    let params: string[] | undefined;
    if ((params = matchRoute(url, /^\/workspace-templates\/([^/]+)\/privileged$/)) && request.method === "POST") return await updateWorkspaceTemplatePrivilegeEndpoint(params[0]!, request);
    if ((params = matchRoute(url, /^\/workspace-templates\/([^/]+)\/dockerfile$/)) && request.method === "POST") return await updateWorkspaceTemplateDockerfileEndpoint(params[0]!, request);
    if ((params = matchRoute(url, /^\/workspace-templates\/([^/]+)\/seed-config$/)) && request.method === "POST") return await updateWorkspaceTemplateSeedConfigEndpoint(params[0]!, request);
    if ((params = matchRoute(url, /^\/workspace-templates\/([^/]+)\/preload-images$/)) && request.method === "POST") return await updateWorkspaceTemplatePreloadImagesEndpoint(params[0]!, request);
    if ((params = matchRoute(url, /^\/workspace-templates\/([^/]+)$/)) && request.method === "GET" && requestAcceptsJson(request)) return await workspaceTemplateDetailEndpoint(params[0]!);
    if ((params = matchRoute(url, /^\/workspace-templates\/([^/]+)$/)) && request.method === "POST") return await updateWorkspaceTemplateEndpoint(params[0]!, request);
    if ((params = matchRoute(url, /^\/workspace-templates\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteWorkspaceTemplateEndpoint(params[0]!, request);
    if ((params = matchRoute(url, /^\/workspace-template-agent-workspaces\/([^/]+)$/)) && request.method === "POST") return await deps.createAgentWorkspace(await workspaceTemplateById(params[0]!), request);
    return undefined;
  }

  async function handle(request: Request, url: URL): Promise<Response | undefined> {
    try {
      return await handleRoute(request, url);
    } catch (error) {
      if (!requestAcceptsJson(request) && request.method === "POST" && (url.pathname.startsWith("/workspace-templates/") || url.pathname.startsWith(`${globalWorkspaceSettingsPath}/`)) && error instanceof AgentsInTheCloudCoreError && ["invalid_arguments", "invalid_ssh_private_key", "workspace_template_secret_exists", "workspace_template_environment_variable_exists", "workspace_template_exists", "workspace_template_secret_not_found", "workspace_template_environment_variable_not_found", "workspace_template_ssh_key_not_found"].includes(error.code)) {
        const errorId = url.pathname.startsWith(`${globalWorkspaceSettingsPath}/`) && !editedTemplateId(globalWorkspaceConfiguration, url) ? globalWorkspaceSettingsErrorId : templateSettingsErrorId;
        return turboStreamResponse(update(errorId, templateSettingsErrorHtml(error.code === "invalid_ssh_private_key" ? "This key couldn’t be read. Paste an unencrypted OpenSSH private key and try again." : error.message)), { status: 422 });
      }
      throw error;
    }
  }
  return { handle, byReference, editorHtml: workspaceTemplateEditorHtml, settingsFrame: (id, location) => renderTemplateSettingsFrame(id, location, deps.referencingWorkspaces(id)) };
}
