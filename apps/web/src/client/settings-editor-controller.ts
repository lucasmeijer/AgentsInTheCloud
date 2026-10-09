import { resetButtonConfirmation } from "@agents-in-the-cloud/design-system/button-confirmation/client";
import { Controller } from "@hotwired/stimulus";
import { setToggleValue, type ToggleChangeEvent } from "@agents-in-the-cloud/design-system/toggle/client";

export type SettingsEditorLoadedEvent = CustomEvent<{ location: string; submitted: boolean }>;

/** Browser-owned draft, save and focus behavior for server-rendered settings editors in one Turbo frame. */
export class SettingsEditorController extends Controller<HTMLElement> {
  static targets = ["form", "frame", "content", "colorPicker", "error", "requestError"];
  declare readonly formTargets: HTMLFormElement[];
  declare readonly frameTarget: HTMLElement;
  declare readonly contentTarget: HTMLElement;
  declare readonly errorTarget: HTMLElement;
  declare readonly requestErrorTarget: HTMLElement;
  private readonly originals = new Map<HTMLFormElement, string>();
  private readonly preservedOriginals = new Map<string, string>();
  private submissions = 0;
  private renders = 0;
  private readonly autosaves = new Map<HTMLFormElement, ReturnType<typeof setTimeout>>();
  private submittedFocus?: { key: string; name: string; start: number | null; end: number | null };

  connect(): void {
    this.element.addEventListener("turbo:before-frame-render", this.beforeFrameRender);
    document.addEventListener("turbo:before-stream-render", this.beforeStreamRender);
    this.loaded();
  }

  disconnect(): void {
    this.element.removeEventListener("turbo:before-frame-render", this.beforeFrameRender);
    document.removeEventListener("turbo:before-stream-render", this.beforeStreamRender);
    for (const timer of this.autosaves.values()) clearTimeout(timer);
  }

  get busy(): boolean { return this.submissions > 0; }
  dirty(): boolean { return this.formTargets.some(form => this.originals.has(form) && this.originals.get(form) !== this.values(form)); }
  markClean(): void { this.formTargets.forEach(form => this.originals.set(form, this.values(form))); }
  resumeAutosaves(): void { this.formTargets.forEach(form => this.queueAutosave(form)); }
  /** Reload the frame at another location of the same page. */
  reload(destination: string): void { this.frameTarget.setAttribute("src", destination); }

  formTargetConnected(form: HTMLFormElement): void {
    // New-secret host defaults are initialized by their own Stimulus controller first.
    requestAnimationFrame(() => {
      if (!form.isConnected) return;
      const key = form.dataset.settingsEditorFormKey!;
      this.originals.set(form, this.preservedOriginals.has(key) ? this.preservedOriginals.get(key)! : this.values(form));
      this.preservedOriginals.delete(key);
      this.updateSave(form);
    });
  }
  formTargetDisconnected(form: HTMLFormElement): void {
    this.originals.delete(form);
    clearTimeout(this.autosaves.get(form));
    this.autosaves.delete(form);
  }

  private values(form: HTMLFormElement): string { return JSON.stringify([...new FormData(form).entries()]); }
  private updateSave(form: HTMLFormElement): void {
    const button = form.querySelector<HTMLButtonElement>("[data-settings-editor-save]")!;
    const original = this.originals.get(form);
    // New server-rendered forms stay disabled until their initial snapshot is captured.
    const unchanged = original === undefined || original === this.values(form);
    button.disabled = this.submissions > 0 || unchanged || form.dataset.settingsEditorAvailable === "false";
    // New edits restore the action immediately; the shared feedback timer never owns disabled state.
    if (!unchanged && !this.submissions) resetButtonConfirmation(button);
  }
  colorPickerTargetConnected(picker: HTMLInputElement): void {
    const color = picker.closest("form")!.querySelector<HTMLInputElement>('input[name="swatchColor"]')!.value;
    // Canvas converts the existing OKLCH swatch to the native picker's sRGB hex format.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color || picker.dataset.defaultColor!;
    picker.parentElement!.querySelector<HTMLElement>(".workspace-template-icon")!.style.setProperty("--workspace-template-swatch", color || picker.dataset.defaultColor!);
    context.fillRect(0, 0, 1, 1);
    picker.value = "#" + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(channel => channel.toString(16).padStart(2, "0")).join("");
  }
  colorChanged(event: Event): void {
    // Wait for the native picker to commit so autosave does not interrupt color browsing.
    if (event.type === "input") { event.stopPropagation(); return; }
    // SAFETY: This change action is bound only to the native color input.
    const picker = event.target as HTMLInputElement;
    picker.closest("form")!.querySelector<HTMLInputElement>('input[name="swatchColor"]')!.value = picker.value;
    picker.parentElement!.querySelector<HTMLElement>(".workspace-template-icon")!.style.setProperty("--workspace-template-swatch", picker.value);
    this.changed(event);
  }
  changed(event: Event): void {
    // SAFETY: These actions are bound only to inputs/toggles inside server-rendered forms.
    const form = (event.target as HTMLElement).closest("form")!;
    this.updateSave(form);
    this.queueAutosave(form);
  }
  toggleChanged(event: ToggleChangeEvent): void {
    // SAFETY: These actions are bound only to inputs/toggles inside server-rendered forms.
    const form = (event.target as HTMLElement).closest("form")!;
    form.querySelector<HTMLInputElement>(`input[type="hidden"][name="${CSS.escape(event.detail.name)}"]`)!.value = event.detail.value;
    this.updateSave(form);
    this.queueAutosave(form);
  }
  private queueAutosave(form: HTMLFormElement): void {
    if (!form.hasAttribute("data-settings-editor-autosave")) return;
    clearTimeout(this.autosaves.get(form));
    this.autosaves.set(form, setTimeout(() => {
      this.autosaves.delete(form);
      const button = form.querySelector<HTMLButtonElement>("[data-settings-editor-save]")!;
      // An open dialog, such as a discard confirmation, holds autosaves until it closes.
      if (!form.isConnected || this.element.querySelector("dialog[open]") || button.disabled || !form.checkValidity()) return;
      form.requestSubmit(button);
    }, 600));
  }
  reset(event: Event): void {
    // SAFETY: Reset actions are bound to buttons inside editor forms.
    const form = (event.target as HTMLElement).closest("form")!;
    form.reset();
    for (const picker of form.querySelectorAll<HTMLInputElement>('input[type="color"]')) this.colorPickerTargetConnected(picker);
    for (const toggle of form.querySelectorAll<HTMLElement>('[data-controller~="toggle"]')) {
      const name = toggle.querySelector<HTMLButtonElement>("button[name]")!.name;
      setToggleValue(toggle, form.querySelector<HTMLInputElement>(`input[type="hidden"][name="${CSS.escape(name)}"]`)!.value);
    }
    this.updateSave(form);
    form.closest("details")?.querySelector("summary")?.focus();
  }

  submitting(event: Event): void {
    this.dismissError();
    this.submissions++;
    // SAFETY: Turbo submit events target the form whose lifecycle is being reported.
    const form = event.target as HTMLFormElement;
    const active = document.activeElement;
    this.submittedFocus = form.contains(active) && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ? { key: form.dataset.settingsEditorFormKey!, name: active.name, start: active.selectionStart, end: active.selectionEnd } : undefined;
    form.inert = true;
    form.querySelector("[data-settings-editor-save]")?.setAttribute("aria-busy", "true");
    this.formTargets.forEach(item => this.updateSave(item));
  }
  submitted(event: CustomEvent<{ success: boolean; fetchResponse?: { response: Response } }>): void {
    this.submissions--;
    // SAFETY: Turbo submit events target the submitting form.
    const form = event.target as HTMLFormElement;
    form.inert = false;
    form.querySelector("[data-settings-editor-save]")?.removeAttribute("aria-busy");
    this.formTargets.forEach(item => {
      this.updateSave(item);
      if (item !== form || event.detail.success) this.queueAutosave(item);
    });
    if (!event.detail.success) this.submittedFocus = undefined;
    if (!event.detail.success && form.hasAttribute("data-settings-editor-autosave")) form.querySelector<HTMLElement>("[data-settings-editor-save-actions]")!.hidden = false;
    // Validation streams own their error rendering and focus. Transport failures have no stream.
    if (!event.detail.success && !event.detail.fetchResponse?.response.headers.get("Content-Type")?.startsWith("text/vnd.turbo-stream.html")) this.showRequestError();
  }
  dismissError(): void {
    this.errorTarget.replaceChildren();
    this.requestErrorTarget.hidden = true;
  }
  frameMissing(event: Event): void {
    event.preventDefault();
    this.showRequestError();
  }
  private focusError(error: HTMLElement): void {
    error.scrollIntoView({ block: "nearest" });
    error.querySelector<HTMLButtonElement>("button")!.focus();
  }
  private showRequestError(): void {
    this.requestErrorTarget.hidden = false;
    this.focusError(this.requestErrorTarget);
  }

  private loaded(): void {
    if (this.renders) return;
    const content = this.contentTarget;
    this.dispatch("loaded", { detail: { location: new URL(content.dataset.settingsEditorLocation!, location.href).href, submitted: content.hasAttribute("data-settings-editor-submitted-path") } });
    const key = content.dataset.settingsEditorFocus;
    const record = key ? this.frameTarget.querySelector<HTMLElement>(`[data-settings-editor-record="${CSS.escape(key)}"]`) : null;
    const savedForm = this.frameTarget.querySelector<HTMLFormElement>("[data-settings-editor-saved-form]");
    const actions = savedForm && !savedForm.hasAttribute("data-settings-editor-autosave") ? savedForm.querySelector<HTMLElement>("[data-settings-editor-save-actions]") : null;
    const submittedFocus = this.submittedFocus;
    this.submittedFocus = undefined;
    const focusForm = submittedFocus ? this.frameTarget.querySelector<HTMLFormElement>(`[data-settings-editor-form-key="${CSS.escape(submittedFocus.key)}"]`) : null;
    requestAnimationFrame(() => {
      if (focusForm && submittedFocus && (!actions || focusForm !== savedForm)) {
        const input = focusForm.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${CSS.escape(submittedFocus.name)}"]`)!;
        input.focus({ preventScroll: true });
        if (submittedFocus.start !== null) input.setSelectionRange(submittedFocus.start, submittedFocus.end);
      } else if (actions?.isConnected) {
        actions.focus({ preventScroll: true });
        actions.scrollIntoView({ block: "nearest" });
      } else if (!content.hasAttribute("data-settings-editor-submitted-path") && record) {
        record.focus({ preventScroll: true });
        record.scrollIntoView({ block: "nearest" });
      }
      savedForm?.removeAttribute("data-settings-editor-saved-form");
      this.resumeAutosaves();
    });
  }

  /** The panel body scrolling this editor: inside its frame, or around it when the frame is embedded in a panel. */
  private scroller(): HTMLElement {
    return this.frameTarget.querySelector<HTMLElement>(".panel__body") ?? this.frameTarget.closest<HTMLElement>(".panel__body")!;
  }

  private async renderPage(nextFrame: HTMLElement, render: () => void | Promise<void>): Promise<void> {
    const active = document.activeElement;
    if ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && this.element.contains(active)) {
      const form = active.closest<HTMLFormElement>("form")!;
      this.submittedFocus = { key: form.dataset.settingsEditorFormKey!, name: active.name, start: active.selectionStart, end: active.selectionEnd };
    }
    const nextContent = nextFrame.querySelector<HTMLElement>('[data-settings-editor-target="content"]')!;
    const submittedPath = nextContent.dataset.settingsEditorSubmittedPath;
    const scrollTop = this.scroller().scrollTop;
    // A save refreshes server-owned markup without throwing away drafts in other editors.
    if (submittedPath) {
      const submittedAction = new URL(submittedPath, location.href).href;
      for (const current of this.frameTarget.querySelectorAll<HTMLDetailsElement>("details[data-settings-editor-disclosure]")) {
        const next = nextFrame.querySelector<HTMLDetailsElement>(`[data-settings-editor-disclosure="${CSS.escape(current.dataset.settingsEditorDisclosure!)}"]`);
        const creating = current.dataset.settingsEditorDisclosure!.endsWith(":new") && actionPath(current.querySelector<HTMLFormElement>("form")!) === submittedAction;
        if (next && !creating) next.open = current.open;
      }
      for (const current of this.formTargets) {
        if (actionPath(current) === submittedAction || `${actionPath(current)}/delete` === submittedAction || this.originals.get(current) === this.values(current)) continue;
        const next = nextFrame.querySelector<HTMLFormElement>(`[data-settings-editor-form-key="${CSS.escape(current.dataset.settingsEditorFormKey!)}"]`);
        if (!next) continue;
        // SAFETY: Cloning an HTMLFormElement preserves its element type.
        const preserved = current.cloneNode(true) as HTMLFormElement;
        preserved.inert = false;
        preserved.dataset.settingsEditorAvailable = next.dataset.settingsEditorAvailable;
        for (const textarea of preserved.querySelectorAll<HTMLTextAreaElement>("textarea")) textarea.readOnly = next.querySelector<HTMLTextAreaElement>(`textarea[name="${CSS.escape(textarea.name)}"]`)!.readOnly;
        preserved.removeAttribute("data-settings-editor-saved-form");
        this.preservedOriginals.set(current.dataset.settingsEditorFormKey!, this.originals.get(current)!);
        next.replaceWith(preserved);
      }
    }
    this.renders++;
    try {
      await render();
      if (submittedPath) this.scroller().scrollTop = scrollTop;
    } finally { this.renders--; }
    if (this.element.isConnected) this.loaded();
  }

  private readonly beforeFrameRender = (event: Event): void => {
    if (event.target !== this.frameTarget) return;
    // SAFETY: Turbo owns the incoming frame and its awaited replacement callback.
    const { detail } = event as CustomEvent<{
      newFrame: HTMLElement;
      render(current: HTMLElement, incoming: HTMLElement): void | Promise<void>;
    }>;
    const render = detail.render;
    detail.render = (current, incoming) => this.renderPage(detail.newFrame, () => render(current, incoming));
  };
  private readonly beforeStreamRender = (event: Event): void => {
    // SAFETY: Turbo exposes the server-rendered stream template and awaited renderer.
    const { detail } = event as CustomEvent<{
      newStream: HTMLElement & { templateElement: HTMLTemplateElement };
      render(stream: HTMLElement): Promise<void>;
    }>;
    const stream = detail.newStream;
    if (stream.getAttribute("target") === this.errorTarget.id) {
      const render = detail.render;
      detail.render = async stream => {
        await render(stream);
        if (this.element.isConnected) this.focusError(this.errorTarget);
      };
      return;
    }
    if (stream.getAttribute("action") !== "replace" || stream.getAttribute("target") !== this.frameTarget.id) return;
    const nextFrame = stream.templateElement.content.querySelector<HTMLElement>("turbo-frame")!;
    const render = detail.render;
    detail.render = stream => this.renderPage(nextFrame, () => render(stream));
  };
}

/** Form actions may carry a view query; drafts are matched by the record path they save. */
function actionPath(form: HTMLFormElement): string {
  const url = new URL(form.action);
  return `${url.origin}${url.pathname}`;
}
