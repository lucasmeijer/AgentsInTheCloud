import { setContentRowLabel } from "@agents-in-the-cloud/design-system/content-row/client";
import { autocompleteHtml } from "@agents-in-the-cloud/design-system/autocomplete";
import { agentComposerSendPromptEvent, changeLayout, composerSubmitKey, type AgentComposerSendPromptDetail, focusLikelyOpensSoftwareKeyboard, isApplePlatform, setTextInputValue, type WorkspaceClientCommand, type WorkspaceClientControllerConstructor as StimulusControllerConstructor, type WorkspaceClientHooks } from "@agents-in-the-cloud/shared";
import { agentCompletionRequest, insertFileCompletion, insertSlashCommand } from "./completion-input.ts";
import { composerPromptSuggestion, promptSuggestionKeyAction } from "./composer-state.ts";
import { createHtmlAutocompleteController } from "./html-autocomplete-controller.ts";
import { handleAgentTreeKeydown, handleAgentTreeMenuEvent, selectAgentTreeOption } from "./session-tree.ts";

const treeComingSoonMessage = "/tree feature is coming soon!";

function showBuiltinSlashCommandNotice(input: HTMLInputElement | HTMLTextAreaElement, message: string): void {
  const notices = input.closest(".agent-pane")!.querySelector<HTMLElement>(".agent-notices")!;
  const notice = document.createElement("div");
  notice.className = "agent-noticeline info";
  notice.dataset.controller = "agent-notice";
  notice.setAttribute("role", "status");
  notice.textContent = message;
  notices.append(notice);
}

function runBuiltinSlashCommand(option: HTMLElement, input: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (option.dataset.commandAction !== "notice") return false;
  input.value = "";
  showBuiltinSlashCommandNotice(input, option.dataset.commandMessage!);
  return true;
}

type ShortcutCommand = Pick<WorkspaceClientCommand, "label" | "binding">;

function promptTemplateBinding(shortcut: string, apple: boolean): string {
  return `${apple ? "Meta" : "Control"}+Alt+Key${shortcut.toUpperCase()}`;
}

export function promptTemplateShortcutConflict(shortcut: string, commands: readonly ShortcutCommand[], apple: boolean): ShortcutCommand | undefined {
  const binding = promptTemplateBinding(shortcut, apple);
  return commands.find((command) => command.binding === binding);
}

function visibleWorkspaceCommands(): ShortcutCommand[] {
  const presentation = document.querySelector<HTMLElement>(".workspace-detail-mount.visible .fixed-workspace-presentation")
    ?? document.querySelector<HTMLElement>(".fixed-workspace-presentation");
  if (!presentation) return [];
  // SAFETY: The server serializes WorkspaceCommandRegistration values into this dataset.
  return JSON.parse(presentation.dataset.workspaceCommands!) as ShortcutCommand[];
}

function workspacePromptTemplateShortcutConflict(hooks: WorkspaceClientHooks, shortcut: string): ShortcutCommand | undefined {
  return promptTemplateShortcutConflict(shortcut, [...hooks.registeredCommands(), ...visibleWorkspaceCommands()], isApplePlatform());
}

function activeAgentComposer(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-workspace-pane-role="agent"].is-active .composer[data-controller~="agent-completions"]')]
    .find((composer) => composer.closest(".workspace-detail-mount")?.classList.contains("visible") ?? true);
}

// Prompt templates with shortcuts are workspace shortcuts aimed at the active Agent,
// independent of focus and of whether its composer is shown.
export function registerPromptTemplateCommands(hooks: WorkspaceClientHooks): void {
  hooks.registerCommandProvider(() => {
    const composer = activeAgentComposer();
    if (!composer) return [];
    const templates = composer.querySelectorAll<HTMLElement>('[data-agent-completions-target="catalog"] [role="option"][data-prompt-template-shortcut]');
    return [...templates].flatMap((template): WorkspaceClientCommand[] => {
      const shortcut = template.dataset.promptTemplateShortcut!;
      if (workspacePromptTemplateShortcutConflict(hooks, shortcut)) return [];
      const trigger = template.dataset.commandTrigger!;
      return [{
        id: `prompt-template.${trigger.slice(1)}`,
        label: `Send ${trigger}`,
        scope: "agent",
        binding: promptTemplateBinding(shortcut, isApplePlatform()),
        run: () => { composer.dispatchEvent(new CustomEvent<AgentComposerSendPromptDetail>(agentComposerSendPromptEvent, { detail: { text: trigger } })); },
      }];
    });
  });
}

function labelPromptTemplateShortcuts(html: string, hooks: WorkspaceClientHooks): string {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  for (const option of container.content.querySelectorAll<HTMLElement>("[data-prompt-template-shortcut]")) {
    const shortcut = option.dataset.promptTemplateShortcut!;
    const key = shortcut.toUpperCase();
    const apple = isApplePlatform();
    const label = apple ? `⌘⌥${key}` : `Ctrl+Alt+${key}`;
    const conflict = workspacePromptTemplateShortcutConflict(hooks, shortcut);
    if (!conflict) {
      option.dataset.agentPromptTemplateButtonShortcut = label;
      option.setAttribute("aria-keyshortcuts", `${apple ? "Meta" : "Control"}+Alt+${key}`);
      continue;
    }
    option.removeAttribute("data-prompt-template-shortcut");
    const message = `Shortcut unavailable: ${label} is used by ${conflict.label}.`;
    option.title = message;
    option.setAttribute("aria-label", `${option.getAttribute("aria-label") ?? option.dataset.commandTrigger}. ${message}`);
    option.classList.add("shortcut-conflict");
    option.dataset.agentPromptTemplateButtonShortcut = `${label} used by ${conflict.label}`;
  }
  return container.innerHTML;
}

function filterSlashCompletionCatalog(html: string, query: string, compactAvailable: boolean): string {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  const menu = container.content.querySelector<HTMLElement>(".autocomplete")!;
  const compact = menu.querySelector<HTMLButtonElement>('[data-command-trigger="/compact"]');
  if (compact && !compactAvailable) {
    compact.disabled = true;
    compact.setAttribute("aria-disabled", "true");
    setContentRowLabel(compact, "/compact [instructions] — Available after more conversation history.");
  }
  const normalized = query.toLowerCase();
  const options = [...menu.querySelectorAll<HTMLButtonElement>("[role=\"option\"]")]
    .filter((option) => option.dataset.commandTrigger!.slice(1).toLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.dataset.commandTrigger!.slice(1).toLowerCase();
      const bName = b.dataset.commandTrigger!.slice(1).toLowerCase();
      return Number(bName.startsWith(normalized)) - Number(aName.startsWith(normalized)) || aName.localeCompare(bName);
    })
    .slice(0, 12);

  if (options.length === 0) return autocompleteHtml({ kind: "message", content: { kind: "text", text: "No matching commands" } });
  menu.replaceChildren(...options);
  const active = options.find((option) => !option.disabled);
  for (const option of options) {
    option.setAttribute("aria-selected", option === active ? "true" : "false");
  }
  return menu.outerHTML;
}

function slashCompletionHtml(catalog: string, query: string, compactAvailable: boolean): string {
  return filterSlashCompletionCatalog(catalog, query, compactAvailable);
}

function promptTemplateButtonHtml(catalog: string): string {
  const container = document.createElement("template");
  container.innerHTML = catalog.trim();
  return container.content.querySelector<HTMLElement>(".agent-prompt-template-buttons")?.outerHTML ?? "";
}

async function expandedSlashCommand(url: string, text: string): Promise<string> {
  const body = new FormData();
  body.set("text", text);
  const response = await fetch(`${url}/slash-command-expand`, { method: "POST", body, headers: { Accept: "text/plain" } });
  return await response.text();
}

function composerSuggestion(input: HTMLInputElement | HTMLTextAreaElement): string | undefined {
  const target = input.closest(".composer")!.querySelector<HTMLElement>("[data-agent-completions-target='suggestion']");
  if (!target) return undefined;
  return composerPromptSuggestion(target.textContent!, input.form!.querySelectorAll(".agent-chip").length);
}

function shownSuggestion(input: HTMLInputElement | HTMLTextAreaElement): string | undefined {
  return input.value === "" ? composerSuggestion(input) : undefined;
}

function suggestionSendable(input: HTMLInputElement | HTMLTextAreaElement): boolean {
  return !input.closest(".composer")!.querySelector('[data-agent-stoppable="true"]');
}

function composerIsDictating(element: Element): boolean {
  return Boolean(element.closest(".composer")?.hasAttribute("data-dictating"));
}

export function createAgentCompletionsController(Controller: StimulusControllerConstructor, hooks: WorkspaceClientHooks) {
  const HtmlAutocompleteController = createHtmlAutocompleteController(Controller, {
    optionSelector: '[role="option"]:not([hidden]):not(:disabled)',
    loadingHtml: autocompleteHtml({ kind: "message", role: "status", content: { kind: "html", html: '<span class="agent-completion-spinner" aria-hidden="true"></span>Loading completions…' } }),
    triggerKeysWhenClosed: ["/", "@"],
    fullscreenShortcut: (option) => option.hasAttribute("data-agents-in-the-cloud-fullscreen-title"),
    menuEvent: handleAgentTreeMenuEvent,
    request(input, force) {
      if (composerIsDictating(input)) return undefined;
      const completion = agentCompletionRequest(input, force);
      if (!completion) return completion;
      interface CompletionRequestParams {
        [name: string]: string;
        kind: typeof completion.kind;
      }
      const params: CompletionRequestParams = { kind: completion.kind };
      if (completion.mode) params["mode"] = completion.mode;
      if (completion.kind === "slash-command") {
        const availability = input.closest(".agent-pane")?.querySelector<HTMLElement>("[data-agent-compact-available]");
        params["compactAvailable"] = String(availability?.dataset.agentCompactAvailable !== "false");
      }
      return { query: completion.query, params, debounceMs: completion.kind === "file" ? 70 : 0 };
    },
    loadHtml(request, host) {
      const catalog = host.querySelector<HTMLElement>("[data-agent-completions-target='catalog']")!.innerHTML;
      const html = request.params?.kind === "slash-command"
        ? slashCompletionHtml(catalog, request.query, request.params.compactAvailable !== "false")
        : undefined;
      return html === undefined ? undefined : labelPromptTemplateShortcuts(html, hooks);
    },
    select(option, input, url) {
      if (runBuiltinSlashCommand(option, input)) return;
      if (selectAgentTreeOption(option, input)) return false;
      if (option.dataset.commandTrigger) insertSlashCommand(option, input);
      else if (option.dataset.completionKind === "file") insertFileCompletion(option, input);
    },
    keydown(event, input, url, actions) {
      const suggestion = actions.open ? undefined : shownSuggestion(input);
      const suggestionAction = suggestion === undefined ? undefined : promptSuggestionKeyAction(event, suggestionSendable(input));
      if (suggestion !== undefined && suggestionAction) {
        actions.setInputValue(suggestion);
        if (suggestionAction === "send") return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      }
      if (event.key === "ArrowUp" && input.value === "" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        actions.close();
        return false;
      }
      const send = composerSubmitKey(event);
      const expand = event.key === "Enter" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      const treeCommand = input.closest(".composer")?.querySelector('[data-agent-completions-target="catalog"] [data-completion-kind="builtin"][data-command-trigger="/tree"]');
      if (event.key === "Enter" && input.value.trim() === "/tree" && treeCommand) {
        event.preventDefault();
        event.stopImmediatePropagation();
        actions.setInputValue("");
        actions.close();
        showBuiltinSlashCommandNotice(input, treeComingSoonMessage);
        return true;
      }
      if (handleAgentTreeKeydown(event, input, actions)) return true;
      if (send || expand) {
        const active = actions.open ? actions.activeOption() : undefined;
        if (active?.dataset.commandTrigger) actions.select(active);
        if (send || !/^\/[^/\s]+(?:\s+[\s\S]*)?$/.test(input.value.trim())) return false;
        event.preventDefault();
        void expandedSlashCommand(url, input.value)
          .then((expanded) => {
            actions.setInputValue(expanded);
            actions.close();
          });
        return true;
      }
      if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey || (actions.open && actions.hasOptions)) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      actions.refresh(true);
      return true;
    },
  });

  return class AgentCompletionsController extends HtmlAutocompleteController {
    static targets = [...HtmlAutocompleteController.targets, "promptTemplateButtons", "suggestion"];
    declare readonly catalogTarget: HTMLElement;
    declare readonly promptTemplateButtonsTarget: HTMLElement;
    declare readonly hasPromptTemplateButtonsTarget: boolean;
    declare readonly suggestionTarget: HTMLElement;
    declare readonly hasSuggestionTarget: boolean;
    private catalogObserver?: MutationObserver;
    private suggestionObserver?: MutationObserver;
    private placeholder = "";

    connect(): void {
      super.connect();
      this.catalogObserver = new MutationObserver(() => { this.renderPromptTemplateButtons(); this.input(); });
      this.catalogObserver.observe(this.catalogTarget, { childList: true });
      if (this.hasPromptTemplateButtonsTarget) this.promptTemplateButtonsTarget.addEventListener("click", this.promptTemplateButton);
      this.renderPromptTemplateButtons();
      this.input();
      if (this.hasSuggestionTarget) this.connectSuggestion();
    }

    disconnect(): void {
      this.catalogObserver?.disconnect();
      this.suggestionObserver?.disconnect();
      if (this.hasPromptTemplateButtonsTarget) this.promptTemplateButtonsTarget.removeEventListener("click", this.promptTemplateButton);
      if (this.hasSuggestionTarget) {
        this.element.removeEventListener("click", this.sendClicked);
        this.inputTarget.form!.removeEventListener("submit", this.suggestionSent);
        this.inputTarget.placeholder = `${this.placeholder}${this.inputTarget.dataset.composerSendHint ?? ""}`;
      }
      super.disconnect();
    }

    private connectSuggestion(): void {
      const form = this.inputTarget.form!;
      const hint = this.inputTarget.dataset.composerSendHint;
      const placeholder = this.inputTarget.placeholder;
      this.placeholder = hint && placeholder.endsWith(hint) ? placeholder.slice(0, -hint.length) : placeholder;
      this.suggestionObserver = new MutationObserver(() => this.renderSuggestion());
      this.suggestionObserver.observe(this.suggestionTarget, { childList: true, characterData: true, subtree: true });
      this.suggestionObserver.observe(form.querySelector('[data-agent-attachments-target="row"]')!, { childList: true });
      this.element.addEventListener("click", this.sendClicked);
      form.addEventListener("submit", this.suggestionSent);
      this.renderSuggestion();
    }

    private renderSuggestion(): void {
      const placeholder = `${composerSuggestion(this.inputTarget) ?? this.placeholder}${this.inputTarget.dataset.composerSendHint ?? ""}`;
      if (this.inputTarget.placeholder === placeholder) return;
      changeLayout(() => {
        this.inputTarget.placeholder = placeholder;
        this.element.dispatchEvent(new Event("agent-composer:resize", { bubbles: true }));
      });
    }

    private readonly sendClicked = (event: MouseEvent): void => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[type="submit"]') : null;
      const input = this.inputTarget;
      if (button?.form !== input.form) return;
      const suggestion = shownSuggestion(input);
      if (suggestion !== undefined && suggestionSendable(input)) setTextInputValue(input, suggestion);
    };

    private readonly suggestionSent = (): void => {
      this.suggestionTarget.replaceChildren();
    };

    private renderPromptTemplateButtons(): void {
      if (!this.hasPromptTemplateButtonsTarget) return;
      const html = labelPromptTemplateShortcuts(promptTemplateButtonHtml(this.catalogTarget.innerHTML), hooks);
      if (this.promptTemplateButtonsTarget.innerHTML === html) return;
      changeLayout(() => {
        this.promptTemplateButtonsTarget.innerHTML = html;
        this.element.dispatchEvent(new Event("agent-composer:resize", { bubbles: true }));
      });
    }

    private readonly promptTemplateButton = (event: MouseEvent): void => {
      const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-agent-prompt-template-button]") : null;
      if (!option) return;
      const input = this.inputTarget;
      const initialValue = input.value;
      void expandedSlashCommand(this.urlValue, option.dataset.commandTrigger!).then((expanded) => {
        if (input.value !== initialValue || composerIsDictating(input)) return;
        setTextInputValue(input, initialValue.trim() ? `${initialValue.trimEnd()}\n\n${expanded}` : expanded);
        if (!focusLikelyOpensSoftwareKeyboard()) input.focus({ preventScroll: true });
      });
    };
  };
}

