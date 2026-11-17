/**
 * Per-frame trace tooling shared by the acceptance scripts. The sampler runs
 * in the page (Chrome via CDP, WebKit via the Web Inspector); the analysis
 * checks user-visible invariants on the recorded frames: every transition is
 * one change, all at once, landing on the settled layout.
 */

export type Box = [number, number, number, number] | null;

export interface Frame {
  t: number;
  transcript: Box;
  terminal: Box;
  composer: Box;
  keyRow: Box;
  floating: Record<string, Box>;
  scrollTop: number | null;
  content: number | null;
  contentBottom: number | null;
  buttons: string[];
  viewport: [number, number];
  pageScroll: number;
  keyboard: boolean;
  focus: string;
}

export interface Mark { t: number; label: string }

export const samplerSource = String.raw`(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const shown = (element) => Boolean(element && element.isConnected && element.checkVisibility());
  const box = (element) => {
    if (!shown(element)) return null;
    const r = element.getBoundingClientRect();
    return r.width === 0 && r.height === 0 ? null : [round(r.left), round(r.top), round(r.width), round(r.height)];
  };
  // Buttons scale while pressed; their layout box is what moves the page.
  const layoutBox = (element) => {
    if (!shown(element)) return null;
    let left = 0, top = 0, node = element;
    while (node) { left += node.offsetLeft; top += node.offsetTop; node = node.offsetParent; }
    return [round(left), round(top), round(element.offsetWidth), round(element.offsetHeight)];
  };
  const first = (selector) => [...document.querySelectorAll(selector)].find(shown) || null;
  const label = (element) => element.getAttribute("aria-label") || element.title || element.textContent.trim();
  const sample = (t) => {
    const transcript = first(".agent-pane .agent-transcript, .cli-transcript-view");
    const pane = first(".agent-composer-pane");
    const composer = first(".launch-composer") || (pane ? pane.querySelector(":scope > .composer") : null);
    const floating = {};
    const stack = first(".floating-stack");
    if (stack) for (const button of stack.querySelectorAll("button, a")) if (shown(button)) floating[label(button)] = layoutBox(button);
    const content = transcript ? transcript.querySelector(".agent-transcript-content") : null;
    const active = document.activeElement;
    return {
      t: round(t),
      transcript: box(transcript),
      terminal: box(first(".observable-terminal-host")),
      composer: box(composer),
      keyRow: box(first(".terminal-key-bar")),
      floating,
      scrollTop: transcript ? round(transcript.scrollTop) : null,
      content: shown(content) ? round(content.getBoundingClientRect().height) : null,
      contentBottom: shown(content) ? round(content.getBoundingClientRect().bottom) : null,
      buttons: composer ? [...composer.querySelectorAll(".composer-button")].filter((slot) => shown(slot) && [...slot.querySelectorAll("button")].some(shown)).map((slot) => slot.classList[1].replace("composer-", "")) : [],
      viewport: [round(visualViewport.height), round(visualViewport.offsetTop)],
      pageScroll: round(window.scrollY),
      keyboard: document.documentElement.classList.contains("software-keyboard-visible"),
      focus: active && active !== document.body ? (active.className && typeof active.className === "string" ? active.tagName.toLowerCase() + "." + active.className.split(" ")[0] : active.tagName.toLowerCase()) : "",
    };
  };
  if (window.__acceptance) { window.__acceptance.frames = []; window.__acceptance.marks = []; return "reset"; }
  const state = window.__acceptance = { frames: [], marks: [] };
  state.mark = (label) => { state.marks.push({ t: Math.round(performance.now() * 10) / 10, label }); return true; };
  state.take = () => { const result = { frames: state.frames, marks: state.marks }; state.frames = []; state.marks = []; return JSON.stringify(result); };
  // RAF's timestamp is the frame's start, not the time this callback samples
  // the DOM. An input dispatched mid-frame can otherwise appear before its mark.
  const loop = () => { state.frames.push(sample(performance.now())); if (state.frames.length > 4000) state.frames.shift(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return "installed";
})()`;

export interface Trace { frames: Frame[]; marks: Mark[] }

interface Channel { key: string; values: number[] }

const boxFields = ["left", "top", "width", "height"] as const;

function channels(frames: Frame[]): Channel[] {
  const result = new Map<string, number[]>();
  const put = (key: string, index: number, value: number): void => {
    let values = result.get(key);
    if (!values) { values = new Array(frames.length).fill(Number.NaN); result.set(key, values); }
    values[index] = value;
  };
  const putBox = (key: string, index: number, value: Box): void => {
    put(`${key}.visible`, index, value ? 1 : 0);
    if (value) boxFields.forEach((field, position) => put(`${key}.${field}`, index, value[position]!));
  };
  const labels = new Set(frames.flatMap((frame) => Object.keys(frame.floating)));
  frames.forEach((frame, index) => {
    putBox("transcript", index, frame.transcript);
    putBox("terminal", index, frame.terminal);
    putBox("composer", index, frame.composer);
    putBox("keyRow", index, frame.keyRow);
    for (const label of labels) putBox(`floating[${label}]`, index, frame.floating[label] ?? null);
    if (frame.scrollTop !== null) put("scrollTop", index, frame.scrollTop);
    put("keyboard", index, frame.keyboard ? 1 : 0);
    put("pageScroll", index, frame.pageScroll);
    put("buttons", index, hash(frame.buttons.join("|")));
  });
  return [...result].map(([key, values]) => ({ key, values }));
}

function hash(text: string): number {
  let value = 0;
  for (const character of text) value = (value * 31 + character.charCodeAt(0)) | 0;
  return value;
}

function differs(a: number, b: number, tolerance: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) !== Number.isNaN(b);
  return Math.abs(a - b) > tolerance;
}

export interface CheckResult { name: string; pass: boolean; evidence: string; note?: string }

export interface TransitionAnalysis {
  window: Frame[];
  changes: Record<string, number[]>;
  changeFrame?: number;
  truncated?: string;
}

/**
 * Analyse the frames from `from` (a mark time) up to `to`. The window ends early
 * when the transcript's content changes (the server added a message), since that
 * is a separate update and not part of the layout transition.
 */
export function analyseTransition(trace: Trace, from: number, to = Number.POSITIVE_INFINITY, options: { endAtContentChange?: boolean } = {}): TransitionAnalysis {
  const startIndex = Math.max(0, trace.frames.findIndex((frame) => frame.t >= from) - 1);
  let window = trace.frames.slice(startIndex).filter((frame) => frame.t <= to);
  let truncated: string | undefined;
  if (options.endAtContentChange !== false) {
    const base = window[0]?.content ?? null;
    const changed = window.findIndex((frame) => base !== null && frame.content !== null && Math.abs(frame.content - base) > 1);
    if (changed > 0) {
      truncated = `window ends at +${Math.round(window[changed]!.t - from)}ms, where the server added transcript content`;
      window = window.slice(0, changed);
    }
  }
  const changes: Record<string, number[]> = {};
  for (const channel of channels(window)) {
    const tolerance = channel.key === "buttons" || channel.key === "keyboard" || channel.key.endsWith(".visible") ? 0 : 1;
    const indices: number[] = [];
    for (let index = 1; index < channel.values.length; index++) {
      if (differs(channel.values[index]!, channel.values[index - 1]!, tolerance)) indices.push(index);
    }
    if (indices.length) changes[channel.key] = indices;
  }
  const frames = new Set(Object.values(changes).flat());
  return { window, changes, changeFrame: frames.size === 1 ? [...frames][0] : undefined, truncated };
}

export function oneStepChecks(analysis: TransitionAnalysis, options: { expectChange?: boolean; correctionAllowed?: boolean } = {}): CheckResult[] {
  const { window, changes } = analysis;
  const keys = Object.keys(changes);
  const multiple = keys.filter((key) => changes[key]!.length > 1);
  const frames = [...new Set(Object.values(changes).flat())].sort((a, b) => a - b);
  const describe = (index: number): string => `frame ${index} (+${Math.round(window[index]!.t - window[0]!.t)}ms)`;
  const results: CheckResult[] = [];
  const correction = options.correctionAllowed && frames.length === 2 && multiple.every((key) => changes[key]!.length <= 2);
  if (options.expectChange !== false) {
    results.push({ name: "Something changed", pass: keys.length > 0, evidence: keys.length ? `${keys.length} channels changed` : "no tracked change in the window" });
  }
  results.push({
    name: "One change per element",
    pass: multiple.length === 0 || Boolean(correction),
    evidence: multiple.length === 0 ? `${keys.length} channels, each changed at most once` : multiple.map((key) => `${key} changed at ${changes[key]!.map(describe).join(", ")}`).join("; "),
    note: correction && multiple.length ? "Allowed exception: first focus without a remembered keyboard height (D12) — one correction." : undefined,
  });
  results.push({
    name: "All at once",
    pass: frames.length <= 1 || Boolean(correction),
    evidence: frames.length <= 1 ? (frames.length ? `all changes in ${describe(frames[0]!)}` : "no changes") : `changes spread over ${frames.map(describe).join(", ")}: ${frames.map((frame) => `[${keys.filter((key) => changes[key]!.includes(frame)).join(", ")}]`).join(" then ")}`,
    note: correction ? "Allowed exception: first focus without a remembered keyboard height (D12) — one correction." : undefined,
  });
  if (analysis.truncated) results.push({ name: "Window", pass: true, evidence: analysis.truncated });
  return results;
}

export function settled(analysis: TransitionAnalysis): Frame {
  return analysis.window.at(-1)!;
}

export function close(a: number, b: number, tolerance = 1): boolean {
  return Math.abs(a - b) <= tolerance;
}

export function check(name: string, pass: boolean, evidence: string): CheckResult {
  return { name, pass, evidence };
}

export function chartSvg(trace: Trace, title: string): string {
  const frames = trace.frames;
  if (frames.length < 2) return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="40"><text x="8" y="24">${escapeXml(title)}: no frames</text></svg>`;
  const width = 900;
  const height = 420;
  const pad = { left: 56, right: 180, top: 28, bottom: 32 };
  const t0 = frames[0]!.t;
  const t1 = frames.at(-1)!.t;
  const series: { name: string; color: string; values: (number | null)[] }[] = [];
  const add = (name: string, color: string, pick: (frame: Frame) => number | null): void => {
    const values = frames.map(pick);
    if (values.some((value) => value !== null)) series.push({ name, color, values });
  };
  const edge = (pick: (frame: Frame) => Box, which: "top" | "bottom") => (frame: Frame) => {
    const value = pick(frame);
    return value ? (which === "top" ? value[1] : value[1] + value[3]) : null;
  };
  add("transcript top", "#4f8fd6", edge((frame) => frame.transcript, "top"));
  add("transcript bottom", "#2a5f9e", edge((frame) => frame.transcript, "bottom"));
  add("terminal top", "#47a36b", edge((frame) => frame.terminal, "top"));
  add("terminal bottom", "#2d7048", edge((frame) => frame.terminal, "bottom"));
  add("composer top", "#d68a2e", edge((frame) => frame.composer, "top"));
  add("composer bottom", "#9e5f1a", edge((frame) => frame.composer, "bottom"));
  add("key row top", "#b0569c", edge((frame) => frame.keyRow, "top"));
  add("viewport height", "#888888", (frame) => frame.viewport[0]);
  add("scrollTop ÷ 4", "#c0c040", (frame) => frame.scrollTop === null ? null : frame.scrollTop / 4);
  const labels = [...new Set(frames.flatMap((frame) => Object.keys(frame.floating)))];
  labels.forEach((label, index) => add(`${label} top`, ["#e05555", "#a03ad0", "#30a0a0", "#707070"][index % 4]!, (frame) => frame.floating[label]?.[1] ?? null));
  const all = series.flatMap((item) => item.values.filter((value): value is number => value !== null));
  const min = Math.min(0, ...all);
  const max = Math.max(...all, 1);
  const x = (t: number): number => pad.left + ((t - t0) / Math.max(1, t1 - t0)) * (width - pad.left - pad.right);
  const y = (value: number): number => pad.top + ((value - min) / Math.max(1, max - min)) * (height - pad.top - pad.bottom);
  const paths = series.map((item) => {
    let d = "";
    item.values.forEach((value, index) => {
      if (value === null) return;
      const command = index > 0 && item.values[index - 1] !== null ? "L" : "M";
      d += `${command}${x(frames[index]!.t).toFixed(1)},${y(value).toFixed(1)} `;
    });
    return `<path d="${d}" fill="none" stroke="${item.color}" stroke-width="1.6"/>`;
  }).join("");
  const legend = series.map((item, index) => `<g transform="translate(${width - pad.right + 12},${pad.top + index * 16})"><rect width="10" height="3" y="4" fill="${item.color}"/><text x="16" y="10" font-size="11">${escapeXml(item.name)}</text></g>`).join("");
  const marks = trace.marks.map((mark) => `<line x1="${x(mark.t)}" x2="${x(mark.t)}" y1="${pad.top}" y2="${height - pad.bottom}" stroke="#999" stroke-dasharray="3 3"/><text x="${x(mark.t) + 3}" y="${pad.top - 6}" font-size="10">${escapeXml(mark.label)}</text>`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => {
    const t = t0 + share * (t1 - t0);
    return `<text x="${x(t)}" y="${height - 10}" font-size="10" text-anchor="middle">${Math.round(t - t0)}ms</text>`;
  }).join("");
  const yTicks = [0, 0.5, 1].map((share) => {
    const value = min + share * (max - min);
    return `<text x="${pad.left - 6}" y="${y(value) + 3}" font-size="10" text-anchor="end">${Math.round(value)}px</text>`;
  }).join("");
  const frameTicks = frames.map((frame) => `<line x1="${x(frame.t).toFixed(1)}" x2="${x(frame.t).toFixed(1)}" y1="${height - pad.bottom}" y2="${height - pad.bottom + 4}" stroke="#bbb"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif">
<rect width="100%" height="100%" fill="#fff"/><text x="${pad.left}" y="16" font-size="13" font-weight="600">${escapeXml(title)} — element edges (y, px, down is lower on screen) per frame</text>
<rect x="${pad.left}" y="${pad.top}" width="${width - pad.left - pad.right}" height="${height - pad.top - pad.bottom}" fill="none" stroke="#ddd"/>
${marks}${paths}${legend}${ticks}${yTicks}${frameTicks}</svg>`;
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
}
