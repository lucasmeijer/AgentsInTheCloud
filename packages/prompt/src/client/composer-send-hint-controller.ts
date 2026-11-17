import { focusLikelyOpensSoftwareKeyboard, isApplePlatform, type WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";

/** Append the platform's send shortcut to the composer placeholder; the server cannot know the viewer's platform.
 * The hint is kept in `data-composer-send-hint` for whatever else changes the placeholder, such as a prompt suggestion. */
export function createComposerSendHintController(Controller: WorkspaceClientControllerConstructor) {
  return class ComposerSendHintController extends Controller {
    declare readonly element: HTMLTextAreaElement;

    initialize(): void {
      if (focusLikelyOpensSoftwareKeyboard()) return;
      const hint = ` · ${isApplePlatform() ? "⌘↩" : "Ctrl+↩"} to send`;
      this.element.dataset.composerSendHint = hint;
      this.element.placeholder += hint;
    }
  };
}
