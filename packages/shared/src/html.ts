export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "�")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type TurboStreamAction = "append" | "prepend" | "before" | "replace" | "update" | "remove";

/** `digest` identifies a live region's whole markup once applied; clients send it back when they
 * subscribe again. `region` names that live region when `targets` selects parts of it. */
export function turboStream(action: TurboStreamAction, target: string, html = "", options: { targets?: boolean; method?: "morph"; digest?: string; region?: string } = {}): string {
  const targetAttribute = options.targets ? "targets" : "target";
  const targetValue = escapeHtml(target);
  const method = options.method ? ` method="${options.method}"` : "";
  const live = `${options.region ? ` region="${escapeHtml(options.region)}"` : ""}${options.digest ? ` digest="${escapeHtml(options.digest)}"` : ""}`;
  if (action === "remove") return `<turbo-stream action="remove" ${targetAttribute}="${targetValue}"${method}${live}></turbo-stream>`;
  return `<turbo-stream action="${action}" ${targetAttribute}="${targetValue}"${method}${live}><template>${html}</template></turbo-stream>`;
}
