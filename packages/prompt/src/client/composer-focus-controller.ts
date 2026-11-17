import { focusLikelyOpensSoftwareKeyboard, type WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";

export function createComposerFocusController(Controller: WorkspaceClientControllerConstructor) {
  return class ComposerFocusController extends Controller {
    preserveInputFocus(event: MouseEvent): void {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const control = event.target.closest("button, a[href]");
      if (!focusLikelyOpensSoftwareKeyboard() && !(control instanceof HTMLButtonElement && control.type === "submit")) return;
      if (!control?.closest(".composer, .agent-composer-opener, .dialog__close-form")) return;
      const input = document.activeElement;
      if (!this.element.contains(control) || !(input instanceof HTMLTextAreaElement) || !this.element.contains(input)) return;

      // On iOS, moving focus before click dismisses the keyboard and can move
      // the composer out from under the tap. Cancel only mousedown's focus
      // transfer: native click still submits forms and opens popovers. Do not
      // cancel touch/pointer events (or synthesize clicks), which can suppress
      // WebKit's native activation and interfere with scrolling.
      event.preventDefault();
    }
  };
}
