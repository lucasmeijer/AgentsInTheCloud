import { domId, escapeHtml } from "@agents-in-the-cloud/shared";
import { branchColor, historyGraph, rowHeight, comparisonGraph, type HistoryModel } from "../history.ts";

export function renderHistoryGraph(model: HistoryModel, historyId: string, moreHtml = ""): string {
  const graph = historyGraph(model.commits);
  const selected = comparisonGraph(graph, model.endpoints, model.topology);
  const rowSelected = (id: string) => selected.selectedRows.includes(id);
  const edges = graph.edges.map(edge => `<path d="${edge.d}" stroke="var(--changes-branch-${edge.lane % 8})"/>`).join("");
  const nodes = graph.nodes.map(node => {
    const commit = node.commit, endpoint = commit.id === selected.target;
    const color = selected.path.includes(commit.id) || endpoint ? "var(--accent)" : `var(--changes-branch-${node.lane % 8})`;
    return `<circle data-dot="${commit.id}" data-ahead="${commit.ahead}" data-color="${node.lane % 8}" cx="${12 + node.lane * 16}" cy="${node.row * rowHeight + 18}" r="${endpoint ? 6 : 3.5}" stroke-width="${endpoint ? 2 : 1.5}" stroke="${color}" fill="${endpoint || commit.ahead ? color : "var(--panel)"}"/>`;
  }).join("");
  const rowBackgrounds = graph.nodes.map(node => `<rect class="changes-history-row-background" data-commit="${node.commit.id}" data-path="${rowSelected(node.commit.id)}" x="0" y="${node.row * rowHeight}" width="${graph.width}" height="${rowHeight}"/>`).join("");
  const svg = `<svg data-changes-diff-endpoints-target="graph" aria-hidden="true" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}"><g>${rowBackgrounds}</g><g class="changes-history-edges" fill="none" stroke-width="1.4">${edges}</g><path data-selected-backbone d="${selected.route}" fill="none" stroke="var(--accent)" stroke-width="1.75"/><path data-selected-beads d="${selected.route}" fill="none" stroke="var(--accent)" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="0 7"/>${nodes}</svg>`;
  const rows = graph.nodes.map((node, index) => {
    const c = node.commit;
    const labels = c.refs.map(ref => `<span class="changes-ref" data-ref-kind="${ref.kind}" style="--changes-ref-color:var(--changes-branch-${branchColor(ref.name, ref.kind)})" title="${escapeHtml(ref.name)}">${escapeHtml(ref.name)}</span>`).join("");
    const stats = c.kind === "commit" ? "" : `<span class="changes-node-stats"><span>${c.stats!.files} ${c.stats!.files === 1 ? "file" : "files"}</span><span class="changes-additions">+${c.stats!.additions}</span><span class="changes-deletions">−${c.stats!.deletions}</span></span>`;
    return `<tr tabindex="0" data-changes-diff-endpoints-target="row" data-commit="${c.id}" data-path="${rowSelected(c.id)}" aria-selected="${rowSelected(c.id)}" aria-label="${escapeHtml(c.subject + (c.ahead ? ` · Not in ${model.upstream}` : ""))}" title="${escapeHtml(c.subject + (c.ahead ? ` · Not in ${model.upstream}` : ""))}" data-action="keydown->changes-diff-endpoints#navigate">
      ${index === 0 ? `<td class="changes-graph-cell" rowspan="${graph.nodes.length}">${svg}</td>` : ""}
      <td class="changes-description"><div class="changes-commit-line">${c.id === model.head ? '<span class="changes-head">HEAD</span>' : ""}${labels}<span class="changes-commit-subject" title="${escapeHtml(c.body ? `${c.subject}\n\n${c.body}` : c.subject)}">${escapeHtml(c.subject)}</span>${stats}</div></td>
      <td data-col="author">${escapeHtml(c.author)}</td><td data-col="date">${escapeHtml(c.date)}</td><td data-col="sha"><code>${c.kind === "commit" ? c.id.slice(0, 7) : "—"}</code></td>
    </tr>`;
  }).join("");
  return `<div id="${domId("changes", historyId, "history")}" class="changes-history-content"><table class="changes-history-table" role="grid" aria-multiselectable="true" aria-label="Local commit history" data-changes-diff-endpoints-target="table" data-action="click->changes-diff-endpoints#selectSnapshot pointermove->changes-diff-endpoints#hoverRow pointerleave->changes-diff-endpoints#clearHover"><colgroup><col class="changes-graph-column" style="width:${graph.width}px"><col><col data-col="author"><col data-col="date"><col data-col="sha"></colgroup><tbody>${rows}</tbody></table>${moreHtml}</div>`;
}
