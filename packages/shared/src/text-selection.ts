export interface QuotableSelection {
  range: Range;
  text: string;
  code: boolean;
  container: Element;
}

export function quotableSelection(document: Document): QuotableSelection | undefined {
  const selection = document.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const container = common instanceof Element ? common : common.parentElement;
  const text = selection.toString();
  if (!text.trim() || !container || container.closest("input, textarea, select")) return undefined;
  return { range, text, code: Boolean(container.closest("pre")), container };
}
