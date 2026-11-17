import { expect, test } from "bun:test";
import { createLivePresentation, liveRegionDigests, placeLiveRegions, type LiveRegion } from "../src/live-presentation.ts";

const transcript = (rows: readonly string[]): LiveRegion => ({
  target: "transcript",
  html: rows.map((_, index) => `<div id="row-${index}" data-turbo-permanent></div>`).join(""),
  children: rows.map((html, index) => ({ target: `row-${index}`, html })),
});

test("a placed region renders the way applying its snapshot leaves it", () => {
  const region: LiveRegion = { ...transcript(["<p>First</p>"]), children: [
    { target: "row-0", html: '<p>First</p><span id="badge"></span>', children: [{ target: "badge", html: "<b id=\"badge\">new</b>", action: "replace" }] },
  ] };
  expect(placeLiveRegions('<div id="transcript"></div>', [region], "page")).toBe('<div id="transcript"><div id="row-0" data-turbo-permanent><p>First</p><b id="badge">new</b></div></div>');
});

test("a page's first snapshot omits what it shows, and later changes still arrive", () => {
  let regions = [transcript(["<p>First</p>"]), { target: "actions", html: "<button>Send</button>" }];
  const presentation = createLivePresentation(() => regions);
  const published: string[] = [];
  presentation.subscribe(html => published.push(html), liveRegionDigests(regions));
  expect(published).toEqual([""]);

  regions = [transcript(["<p>First</p>", "<p>Second</p>"]), regions[1]!];
  presentation.flush();
  expect(published[1]).toContain('target="transcript"');
  expect(published[1]).toContain("Second");
  expect(published[1]).not.toContain("Send");
});

test("regions a page didn't place, or that changed since, are sent", () => {
  const placed = transcript(["<p>First</p>"]);
  const shown = liveRegionDigests([placed]);
  const published: string[] = [];
  createLivePresentation(() => [transcript(["<p>Edited</p>"]), { target: "actions", html: "<button>Send</button>" }]).subscribe(html => published.push(html), shown);
  expect(published[0]).not.toContain('target="transcript"');
  expect(published[0]).toContain("Edited");
  expect(published[0]).toContain("Send");
});

test("a shell shows only the regions it has mounts for, and marks its subscriber with exactly those", () => {
  const regions = [transcript(["<p>First</p>"]), { target: "notices", html: "Elsewhere" }];
  const html = placeLiveRegions('<section id="pane" data-controller="pane"><div id="transcript"></div></section>', regions, "pane");
  expect(html).toContain('<div id="row-0" data-turbo-permanent><p>First</p></div>');
  expect(html).not.toContain("Elsewhere");
  const shown = JSON.parse(html.match(/data-live-shown="([^"]*)"/)![1]!.replaceAll("&quot;", '"'));
  expect(shown).toEqual(liveRegionDigests([regions[0]!]));
});

function published(regions: () => readonly LiveRegion[]) {
  const presentation = createLivePresentation(regions);
  const sent: string[] = [];
  presentation.subscribe(html => sent.push(html));
  return { sent, flush: () => { presentation.flush(); return sent.at(-1) ?? ""; } };
}

test("adding a row sends the collection and the new row, not the rows a client already shows", () => {
  let rows = ["<p>First</p>"];
  const live = published(() => [transcript(rows)]);
  rows = ["<p>First</p>", "<p>Second</p>"];
  const html = live.flush();
  expect(html).toContain('target="transcript"');
  expect(html).toContain('target="row-1"');
  expect(html).not.toContain('target="row-0"');
});

test("a morphed parent resends children whose mounts aren't permanent", () => {
  let label = "Working";
  const live = published(() => [{ target: "turn", html: `<span>${label}</span><div id="items"></div>`, children: [{ target: "items", html: "<p>Item</p>" }] }]);
  label = "Completed";
  const html = live.flush();
  expect(html).toContain('target="turn"');
  expect(html).toContain('target="items"');
});

test("a destructive parent update resends every child", () => {
  let rows = ["<p>First</p>"];
  const live = published(() => [{ ...transcript(rows), morph: false }]);
  rows = ["<p>First</p>", "<p>Second</p>"];
  expect(live.flush()).toContain('target="row-0"');
});

test("a region that moves to another parent is sent to its new mount", () => {
  let inFirst = true;
  const row = { target: "row", html: "<p>Row</p>" };
  const live = published(() => [
    { target: "first", html: inFirst ? '<div id="row" data-turbo-permanent></div>' : "", children: inFirst ? [row] : [] },
    { target: "second", html: inFirst ? "" : '<div id="row" data-turbo-permanent></div>', children: inFirst ? [] : [row] },
  ]);
  inFirst = false;
  expect(live.flush()).toContain('target="row"');
});

test("a mount that only now becomes permanent is emptied by the morph, so its child is resent", () => {
  let permanent = "";
  const live = published(() => [{ target: "turn", html: `<div id="items"${permanent}></div>`, children: [{ target: "items", html: "<p>Item</p>" }] }]);
  permanent = " data-turbo-permanent";
  expect(live.flush()).toContain('target="items"');
});

test("streams carry their region's digest, so a client subscribing again only receives regions that changed since", () => {
  let rows = ["<p>First</p>"];
  const live = published(() => [transcript(rows), { target: "actions", html: "<button>Send</button>" }]);
  rows = ["<p>First</p>", "<p>Second</p>"];
  const applied = Object.fromEntries([...(live.sent[0]! + live.flush()).matchAll(/target="([^"]+)" (?:method="morph" )?digest="([^"]+)"/g)].map(match => [match[1]!, match[2]!]));
  expect(Object.keys(applied).sort()).toEqual(["actions", "row-0", "row-1", "transcript"]);

  const again: string[] = [];
  createLivePresentation(() => [transcript(rows), { target: "actions", html: "<button>Stop</button>" }]).subscribe(html => again.push(html), applied);
  expect(again[0]).toContain('target="actions"');
  expect(again[0]).not.toContain('target="transcript"');
  expect(again[0]).not.toContain('target="row-');
});

test("a block region resends only the blocks that changed, by position", () => {
  let blocks = ["<h1>Title</h1>", "<p>First</p>", "<ul><li>One</li></ul>"];
  const live = published(() => [{ target: "tail", html: blocks.join(""), blocks }]);
  blocks = ["<h1>Title</h1>", "<p>First</p>", "<ul><li>One</li><li>Two</li></ul>", "<p>Next</p>"];
  const grown = live.flush();
  expect(grown).not.toContain("Title");
  expect(grown).toContain('action="replace" targets="[id=&quot;tail&quot;] &gt; :nth-child(3)" method="morph" region="tail"');
  expect(grown).toContain('action="append" target="tail" digest=');
  expect(grown).toContain("<p>Next</p>");

  blocks = ["<h1>Title</h1>", "<p>First, edited</p>"];
  const shrunk = live.flush();
  expect(shrunk).toContain(":nth-child(2)");
  expect(shrunk).toContain('action="remove" targets="[id=&quot;tail&quot;] &gt; :nth-child(n+3)" region="tail" digest=');

  blocks = ["<p>Elsewhere</p>"];
  expect(live.flush()).toContain('action="update" target="tail" method="morph"');
});
