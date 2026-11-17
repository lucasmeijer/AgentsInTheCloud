import type { ButtonOptions } from "../button/button-html.ts";
import { buttonConfirmationMarkup } from "./button-confirmation-markup.ts";

export interface ButtonConfirmationOptions extends ButtonOptions {
  confirmationLabel: string;
  confirmed?: boolean;
  label?: string;
}

export function buttonConfirmationHtml(options: ButtonConfirmationOptions): string {
  return buttonConfirmationMarkup(options);
}
