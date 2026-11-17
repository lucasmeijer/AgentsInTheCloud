import { escapeHtml } from "@agents-in-the-cloud/shared";

export type ToggleData = Record<string, string | number | boolean | undefined>;
export type ToggleVariant = "button" | "text" | "text-subtle";

export interface ToggleElement {
  tag?: "div" | "span";
  id?: string;
  dataAction?: string;
  data?: ToggleData;
}

export interface ToggleForm {
  action: string;
  method?: "get" | "post";
  turbo?: boolean;
  id?: string;
  dataAction?: string;
  data?: ToggleData;
}

interface ToggleOptionBase {
  value: string;
  disabled?: boolean;
  id?: string;
  data?: ToggleData;
}

export type ToggleOption = ToggleOptionBase & { label: string };

interface ToggleOptionsBase {
  variant: ToggleVariant;
  label: string;
  name: string;
  value: string;
  options: ToggleOption[];
}

export type ToggleOptions = ToggleOptionsBase & (
  | { element?: ToggleElement; form?: never }
  | { element?: never; form: ToggleForm }
);

function classes(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function dataHtml(data?: ToggleData, reserved: string[] = []): string {
  if (!data) return "";
  return Object.entries(data).map(([name, value]) => {
    if (reserved.includes(name)) throw new Error(`Toggle data-${name} is owned by the design system`);
    if (value === undefined) return "";
    return ` data-${name}="${escapeHtml(String(value))}"`;
  }).join("");
}

function extensionHtml(extension: Pick<ToggleElement, "id" | "dataAction" | "data"> | undefined, reservedData: string[]): string {
  if (!extension) return "";
  return `${extension.id ? ` id="${escapeHtml(extension.id)}"` : ""}${extension.dataAction ? ` data-action="${escapeHtml(extension.dataAction)}"` : ""}${dataHtml(extension.data, ["controller", "action", ...reservedData])}`;
}

function validate(options: ToggleOptions): void {
  if (options.options.length < 2) throw new Error("A toggle requires at least two options");
  const values = new Set<string>();
  for (const option of options.options) {
    if (values.has(option.value)) throw new Error(`Toggle option value must be unique: ${option.value}`);
    values.add(option.value);
  }
  if (!values.has(options.value)) throw new Error(`Toggle value has no matching option: ${options.value}`);
}

function optionHtml(options: ToggleOptions, option: ToggleOption, kind: "button" | "text", type: "button" | "submit"): string {
  const content = escapeHtml(option.label);
  const id = option.id ? ` id="${escapeHtml(option.id)}"` : "";
  return `<button class="${escapeHtml(`${kind}-toggle__option`)}"${id} type="${type}" name="${escapeHtml(options.name)}" value="${escapeHtml(option.value)}" aria-pressed="${option.value === options.value}"${option.disabled ? " disabled" : ""}${dataHtml(option.data)}>${content}</button>`;
}

export function toggleHtml(options: ToggleOptions): string {
  validate(options);
  const kind = options.variant === "button" ? "button" : "text";
  const extension = options.form ?? options.element;
  const className = classes(`${kind}-toggle`, options.variant === "text-subtle" ? "subtle" : undefined);
  const tag = options.form ? "form" : (options.element?.tag ?? "div");
  const formHtml = options.form
    ? ` method="${options.form.method ?? "post"}" action="${escapeHtml(options.form.action)}" data-turbo="${options.form.turbo ?? true}"`
    : "";
  const content = options.options.map((option) => optionHtml(options, option, kind, options.form ? "submit" : "button")).join("");
  return `<${tag} class="${escapeHtml(className)}" role="group" aria-label="${escapeHtml(options.label)}" data-controller="toggle"${extensionHtml(extension, options.form ? ["turbo"] : [])}${formHtml}>${content}</${tag}>`;
}
