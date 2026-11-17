import { escapeHtml } from "@agents-in-the-cloud/shared";

export interface Comparison { referencePercent: number; valuePercent: number }

export interface ComparisonRingOptions extends Comparison {
  caption: string;
  label: string;
}

function clockwiseArc(percent: number): string {
  if (percent === 0) return "";
  if (percent === 100) return "M14 1 A13 13 0 0 1 14 27 A13 13 0 0 1 14 1";
  const angle = (percent / 100 * 360 - 90) * Math.PI / 180;
  return `M14 1 A13 13 0 ${percent > 50 ? 1 : 0} 1 ${(14 + 13 * Math.cos(angle)).toFixed(4)} ${(14 + 13 * Math.sin(angle)).toFixed(4)}`;
}

export function comparisonRingSvgHtml(comparison: Comparison, className: string): string {
  if ([comparison.referencePercent, comparison.valuePercent].some((value) => !Number.isFinite(value) || value < 0 || value > 100)) throw new RangeError("Comparison percentages must be between 0 and 100");
  return `<svg class="${escapeHtml(className)}" viewBox="0 0 28 28" aria-hidden="true"><path class="comparison-ring__track" d="${clockwiseArc(100)}"/><path class="comparison-ring__reference" d="${clockwiseArc(comparison.referencePercent)}"/><path class="comparison-ring__value" d="${clockwiseArc(comparison.valuePercent)}"/><path class="comparison-ring__shared" d="${clockwiseArc(Math.min(comparison.referencePercent, comparison.valuePercent))}"/></svg>`;
}

export function comparisonRingHtml(options: ComparisonRingOptions): string {
  if (options.caption.length > 3) throw new RangeError("Comparison ring captions fit at most three characters");
  return `<span class="comparison-ring" role="img" aria-label="${escapeHtml(options.label)}" title="${escapeHtml(options.label)}">${comparisonRingSvgHtml(options, "comparison-ring__perimeter")}<span class="comparison-ring__caption" aria-hidden="true">${escapeHtml(options.caption)}</span></span>`;
}
