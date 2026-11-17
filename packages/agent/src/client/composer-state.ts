import { composerSubmitKey, setTextInputValue } from "@agents-in-the-cloud/shared";

export function agentComposerTextStorageKey(workspaceId: string, agentId: string): string {
  return `agents-in-the-cloud.agentComposerText:${JSON.stringify([workspaceId, agentId])}`;
}

export function agentComposerPrimaryAction(busy: boolean, text: string, attachmentCount: number, hasStoppableWork = busy, busyMode: "steer" | "followUp" = "steer"): "abort" | "send" | "steer" | "followUp" {
  if (hasStoppableWork && !text.trim() && attachmentCount === 0) return "abort";
  return busy ? busyMode : "send";
}

export function composerPromptSuggestion(suggestion: string, attachmentCount: number): string | undefined {
  const text = suggestion.trim();
  return text && attachmentCount === 0 ? text : undefined;
}

export function promptSuggestionKeyAction(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, sendable: boolean): "accept" | "send" | undefined {
  if (composerSubmitKey(event)) return sendable ? "send" : undefined;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return undefined;
  return event.key === "Tab" || event.key === "ArrowRight" ? "accept" : undefined;
}

type PromptHistoryState = { prompts: string[]; draft: string; index: number };

export function navigatePromptHistory(state: PromptHistoryState | undefined, direction: "up" | "down", draft: string, prompts: string[]): { state: PromptHistoryState | undefined; value: string } | undefined {
  if (!state) {
    if (direction === "down" || prompts.length === 0) return undefined;
    const next = { prompts, draft, index: prompts.length - 1 };
    return { state: next, value: prompts[next.index] };
  }
  if (direction === "up") {
    const next = { ...state, index: Math.max(0, state.index - 1) };
    return { state: next, value: next.prompts[next.index] };
  }
  if (state.index === state.prompts.length - 1) return { state: undefined, value: state.draft };
  const next = { ...state, index: state.index + 1 };
  return { state: next, value: next.prompts[next.index] };
}

export class PromptHistoryNavigator {
  private state?: PromptHistoryState;
  private applying = false;

  keydown(event: KeyboardEvent, input: HTMLTextAreaElement, prompts: () => string[]): boolean {
    const direction = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : undefined;
    const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const atPromptStart = input.selectionStart === 0 && input.selectionEnd === 0;
    if (!direction || !noModifiers || (!this.state && (direction !== "up" || !atPromptStart))) return false;
    const navigation = navigatePromptHistory(this.state, direction, input.value, this.state?.prompts ?? prompts());
    if (!navigation) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.state = navigation.state;
    this.applying = true;
    setTextInputValue(input, navigation.value);
    this.applying = false;
    return true;
  }

  inputChanged(): void {
    if (!this.applying) this.state = undefined;
  }
}
