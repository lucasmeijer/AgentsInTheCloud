export function notifyInputListeners(input: HTMLInputElement | HTMLTextAreaElement): void {
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function setTextInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  notifyInputListeners(input);
}
