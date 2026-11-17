import { Type, type Static } from "typebox";
import { escapeHtml, turboStream } from "./html.ts";

export interface LiveRegion {
  target: string;
  html: string;
  action?: "update" | "replace";
  morph?: boolean;
  appendOnly?: boolean;
  /** `html` as a sequence of blocks that are one element each. An update resends only the
   * blocks that changed since, by position, rather than the whole region. */
  blocks?: readonly string[];
  children?: readonly LiveRegion[];
}

export interface LiveSubscription {
  unsubscribe(): void;
}

/** Digests of the regions a page shows, by target: placed by the server render, or applied from
 * streams since. A subscription's first snapshot omits regions whose digest is still current. */
export const liveRegionDigestsSchema = Type.Record(Type.String(), Type.String());
export type LiveRegionDigests = Readonly<Static<typeof liveRegionDigestsSchema>>;

export const liveShownAttribute = "data-live-shown";

function liveRegionDigest(html: string): string {
  return Bun.hash(html).toString(36);
}

/** Markup for a region's target exactly as applying its snapshot leaves it: the target's
 * content, or for `replace` the element itself, with every child region placed. */
function liveRegionHtml(region: LiveRegion): string {
  return region.children?.length ? fill(region.html, region.children) : region.html;
}

function fill(html: string, regions: readonly LiveRegion[], subscriber?: { id: string; shown: LiveRegionDigests }): string {
  const byTarget = new Map(regions.map(region => [region.target, region]));
  return new HTMLRewriter().on("[id]", { element(element) {
    const id = element.getAttribute("id")!;
    if (id === subscriber?.id) element.setAttribute(liveShownAttribute, JSON.stringify(subscriber.shown));
    const region = byTarget.get(id);
    if (!region) return;
    const content = liveRegionHtml(region);
    if (region.action === "replace") element.replace(content, { html: true });
    else element.setInnerContent(content, { html: true });
  } }).transform(html);
}

/** A shell whose live content another presentation owns, as a page shows it: the regions
 * it has mounts for placed, and its subscriber marked with exactly those. */
export function placeLiveRegions(shell: string, regions: readonly LiveRegion[], subscriberId: string): string {
  const mounts = new Set<string>();
  new HTMLRewriter().on("[id]", { element(element) { mounts.add(element.getAttribute("id")!); } }).transform(shell);
  const placed = regions.filter(region => mounts.has(region.target));
  return fill(shell, placed, { id: subscriberId, shown: liveRegionDigests(placed) });
}

export function liveRegionDigests(regions: readonly LiveRegion[], digests: Record<string, string> = {}): LiveRegionDigests {
  for (const region of regions) {
    digests[region.target] = liveRegionDigest(region.html);
    if (region.children) liveRegionDigests(region.children, digests);
  }
  return digests;
}

/** What a client last received for a target: its markup, the parent region it was mounted
 * in, and for a region with children, which of its elements the page holds as permanent. */
interface SentRegion { html: string; parent?: string; islands?: ReadonlySet<string>; blocks?: readonly string[] }

function permanentIslands(html: string): Set<string> {
  const ids = new Set<string>();
  new HTMLRewriter().on("[id][data-turbo-permanent]", { element(element) { ids.add(element.getAttribute("id")!); } }).transform(html);
  return ids;
}

function sentRegion(region: LiveRegion, parent: string | undefined): SentRegion {
  return { html: region.html, parent, islands: region.children ? permanentIslands(region.html) : undefined, blocks: region.blocks };
}

/** Streams that bring a block region from `before` to `after`: changed blocks morph in place,
 * then extra ones go and new ones follow. Only the last carries the region's digest, so a
 * client that stops partway doesn't claim to show the result. */
function blockStreams(target: string, before: readonly string[], after: readonly string[], digest: string): string | undefined {
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) same++;
  if (same === 0) return undefined;
  const children = (selector: string) => `[id="${target}"] > ${selector}`;
  const streams: ((digest?: string) => string)[] = [];
  for (let index = same; index < Math.min(before.length, after.length); index++) {
    streams.push(digest => turboStream("replace", children(`:nth-child(${index + 1})`), after[index], { targets: true, method: "morph", region: target, digest }));
  }
  if (after.length < before.length) streams.push(digest => turboStream("remove", children(`:nth-child(n+${after.length + 1})`), "", { targets: true, region: target, digest }));
  if (after.length > before.length) streams.push(digest => turboStream("append", target, after.slice(before.length).join(""), { digest }));
  return streams.map((stream, index) => stream(index === streams.length - 1 ? digest : undefined)).join("");
}

/** `forced` regions are sent even when unchanged: the client lacks them or just lost them.
 * A morph leaves elements that are already permanent on the page untouched, so regions
 * mounted in those aren't resent after it: resending would reset client-owned state in
 * rows that didn't change. */
function regionStreams(regions: readonly LiveRegion[], previous: Map<string, SentRegion>, forced: boolean, shown: LiveRegionDigests = {}, parent?: string): string {
  let html = "";
  for (const region of regions) {
    const before = previous.get(region.target);
    const moved = before !== undefined && before.parent !== parent;
    const changed = forced || moved || before?.html !== region.html;
    let sent = false;
    if (forced && shown[region.target] === liveRegionDigest(region.html)) previous.set(region.target, sentRegion(region, parent));
    else if (changed) {
      const append = !forced && !moved && region.appendOnly && before !== undefined && region.html.startsWith(before.html);
      const digest = liveRegionDigest(region.html);
      const blocks = !forced && !moved && region.blocks && before?.blocks && (region.action ?? "update") === "update" ? blockStreams(region.target, before.blocks, region.blocks, digest) : undefined;
      html += blocks ?? turboStream(append ? "append" : region.action ?? "update", region.target, append ? region.html.slice(before.html.length) : region.html, append || region.morph === false ? { digest } : { method: "morph", digest });
      previous.set(region.target, sentRegion(region, parent));
      sent = true;
    }
    if (!region.children) continue;
    // Initial snapshots send every child. After an update, only children mounted in islands
    // that were already permanent on the page, and still are, keep their content (Turbo
    // checks the existing element). Every other child is resent, which is merely cautious
    // for an append.
    const kept = new Set<string>();
    if (sent && !moved && region.morph !== false && before?.islands) {
      const now = previous.get(region.target)!.islands!;
      for (const id of before.islands) if (now.has(id)) kept.add(id);
    }
    for (const child of region.children) {
      html += regionStreams([child], previous, forced || (sent && !kept.has(child.target)), shown, region.target);
    }
  }
  return html;
}

/** One synchronous read/render/send path for initial state, changes and reconnects.
 * Invalidation coalesces; no snapshots, promises or event history are queued. */
export function createLivePresentation(render: () => readonly LiveRegion[], intervalMs = 0) {
  const listeners = new Set<(html: string) => void>();
  const previous = new Map<string, SentRegion>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed || listeners.size === 0) return;
    const regions = render();
    const html = regionStreams(regions, previous, false);
    const targets = new Set<string>();
    const visit = (items: readonly LiveRegion[]): void => {
      for (const item of items) { targets.add(item.target); if (item.children) visit(item.children); }
    };
    visit(regions);
    for (const target of previous.keys()) if (!targets.has(target)) previous.delete(target);
    if (html) for (const listener of listeners) listener(html);
  }

  return {
    invalidate(): void {
      if (!disposed && listeners.size && timer === undefined) timer = setTimeout(flush, intervalMs);
    },
    flush,
    subscribe(listener: (html: string) => void, shown?: LiveRegionDigests): LiveSubscription {
      if (disposed) throw new Error("Live presentation is disposed");
      flush();
      const regions = render();
      const html = regionStreams(regions, previous, true, shown);
      listeners.add(listener);
      try { listener(html); } catch (error) { listeners.delete(listener); throw error; }
      return { unsubscribe() {
        listeners.delete(listener);
        if (listeners.size === 0) {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          previous.clear();
        }
      } };
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      listeners.clear();
      previous.clear();
    },
  };
}

/** A keyed collection is represented by stable islands and independently rendered rows.
 * One generic morph reorders/removes islands; row updates never remount unchanged rows. */
export function liveCollection(target: string, rows: readonly { id: string; html: string; children?: readonly LiveRegion[] }[]): LiveRegion {
  return {
    target,
    html: rows.map(({ id }) => `<div id="${escapeHtml(id)}" data-turbo-permanent></div>`).join(""),
    children: rows.map(({ id, html, children }) => ({ target: id, html, children })),
  };
}

/** Asynchronous enrichment ends here, before publication. Invalidations during a
 * load discard its result. All waiters join the latest refresh, never an old one. */
export function createPublishedRefresh<T>(load: () => Promise<T>, publish: (value: T) => void) {
  let generation = 0;
  let pending: Promise<void> | undefined;
  let disposed = false;
  return {
    invalidate(): void { generation++; },
    refresh(): Promise<void> {
      if (disposed) throw new Error("Published refresh is disposed");
      generation++;
      if (pending) return pending;
      const completion = Promise.withResolvers<void>();
      pending = completion.promise;
      void (async () => {
        try {
          for (;;) {
            const started = generation;
            const value = await load();
            if (disposed) return;
            if (started !== generation) continue;
            publish(value);
            if (started === generation) return;
          }
        } finally {
          // Release ownership in the worker's final synchronous step, not in a
          // later promise reaction that could swallow a new refresh request.
          pending = undefined;
        }
      })().then(completion.resolve, completion.reject);
      return completion.promise;
    },
    dispose(): void { disposed = true; generation++; },
  };
}
