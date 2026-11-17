import { describe, expect, test } from "bun:test";
import { fixtures, paths } from "./cases.ts";
import { measure, summary } from "./measure.ts";

// Explicit opt-in: bun test ./packages/syntax/bench/repro.perf.ts
// These are performance assertions, not markup/snapshot/UI assertions.
const maxUpdateMs = 50;
const maxHighlightMs = 20;
const maxStreamMs = 1_000;

async function check(path: typeof paths[number], fixture: typeof fixtures[number], chunkSize = 0) {
  const result = await measure(path, fixture, chunkSize);
  const report = summary(result);
  console.log(JSON.stringify(report));
  expect(result.stderr, "child errors").toBe("");
  expect(result.timedOut, "10 second external process budget exceeded; partial measurements printed above").toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.samples.length, "all requested updates completed").toBe(result.expectedUpdates);
  expect(report.maxHighlightMs, "maximum shared server highlight budget (ms)").toBeLessThan(maxHighlightMs);
  expect(report.maxUpdateMs, "render operation budget (ms)").toBeLessThan(maxUpdateMs);
  if (chunkSize) expect(report.totalMs, "entire uncoalesced streaming replay budget (ms)").toBeLessThan(maxStreamMs);
}

describe("captured Slay highlighting performance", () => {
  for (const fixture of fixtures) {
    for (const path of paths) {
      test(`${fixture} / ${path} / full and repeat`, () => check(path, fixture), 15_000);
    }
  }
  for (const fixture of ["style.css", "view.js"] as const) {
    for (const path of ["write", "markdown"] as const) {
      for (const chunkSize of [32, 256, 2048]) {
        test(`${fixture} / ${path} / ${chunkSize} character prefixes`, () => check(path, fixture, chunkSize), 15_000);
      }
    }
  }
});
