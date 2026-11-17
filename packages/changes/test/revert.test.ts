import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDiffFromFile } from "@pierre/diffs";
import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { canRevertFile, changeBlocks, revertAnchor, revertBlockEdit, type LineEdit } from "../src/reverting.ts";
import { captureChanges } from "../src/server/snapshot.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const lines = (count: number, change: (line: number) => string | undefined = () => undefined) => Array.from({ length: count }, (_, index) => change(index + 1) ?? `line ${index + 1}\n`).join("");

function apply(text: string, { range, newText }: LineEdit): string {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
  const offset = ({ line, character }: { line: number; character: number }) => line >= starts.length ? text.length : starts[line]! + character;
  return text.slice(0, offset(range.start)) + newText + text.slice(offset(range.end));
}
function revert(base: string, draft: string, index: number): string {
  const diff = parseDiffFromFile({ name: "file.ts", contents: base }, { name: "file.ts", contents: draft }, { context: 3 });
  return apply(draft, revertBlockEdit(diff, changeBlocks(diff)[index]!));
}

test("reverting one change block inside a multi-block hunk restores only that block", () => {
  const base = lines(12);
  const draft = lines(12, line => line === 2 ? "changed 2\n" : line === 5 ? "line 5\ninserted\n" : undefined);
  const diff = parseDiffFromFile({ name: "file.ts", contents: base }, { name: "file.ts", contents: draft }, { context: 3 });
  expect(diff.hunks).toHaveLength(1);
  expect(changeBlocks(diff)).toHaveLength(2);
  expect(revert(base, draft, 1)).toBe(lines(12, line => line === 2 ? "changed 2\n" : undefined));
  expect(revert(base, draft, 0)).toBe(lines(12, line => line === 5 ? "line 5\ninserted\n" : undefined));
});

test("adjacent changed lines form one hunk, so reverting a hunk never merges the ones after it", () => {
  const base = lines(12, line => line === 6 ? "if (hello) return world;\n" : undefined);
  const draft = lines(12, line => line === 6 ? "const name = read();\nif (hello) return name;\nwarn();\n" : undefined);
  const before = parseDiffFromFile({ name: "file.ts", contents: base }, { name: "file.ts", contents: draft }, { context: 3 });
  expect(changeBlocks(before).map(({ additions, deletions }) => ({ additions, deletions }))).toEqual([{ additions: 3, deletions: 1 }]);
  expect(revert(base, draft, 0)).toBe(base);
});

test("pure insertions, pure deletions and missing final newlines round-trip to the base", () => {
  const base = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
  expect(revert(base, "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk", 0)).toBe(base);
  expect(revert(base, "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", 0)).toBe(base);
  expect(revert(base, "a\nc\nd\ne\nf\ng\nh\ni\nj", 0)).toBe(base);
  expect(revert("a\nb\n", "a\nB", 0)).toBe("a\nb\n");
  expect(revert("a\nb\n", "", 0)).toBe("a\nb\n");
});

test("revert buttons sit on the line above their change, or follow a change at the top of the file", () => {
  const diff = parseDiffFromFile({ name: "file.ts", contents: lines(12) }, { name: "file.ts", contents: lines(12, line => line === 1 ? "one\n" : line === 8 ? "" : undefined) }, { context: 3 });
  expect(changeBlocks(diff).map(revertAnchor)).toEqual([{ lineNumber: 1, side: "additions" }, { lineNumber: 7, side: "additions" }]);
});

test("revert is offered where editing is: working-tree text files with a text base", async () => {
  const root = await mkdtemp(join(tmpdir(), "changes-revert-")); directories.push(root);
  const repo = localRepository(root);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"]]) await repo.gitResult(args);
  await writeFile(join(root, "file.ts"), lines(3));
  await repo.gitResult(["add", "."]); await repo.gitResult(["commit", "-m", "initial"]);
  await writeFile(join(root, "file.ts"), lines(3, line => line === 2 ? "two\n" : undefined));
  await writeFile(join(root, "added.ts"), "new\n");
  await writeFile(join(root, "mixed.ts"), "a\r\nb\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  const snapshot = await captureChanges(repo);
  expect(canRevertFile(snapshot.files.get("file.ts")!)).toBe(true);
  expect(canRevertFile(snapshot.files.get("added.ts")!)).toBe(false);
  expect(canRevertFile(snapshot.files.get("mixed.ts")!)).toBe(false);
  expect(canRevertFile(snapshot.files.get("binary.bin")!)).toBe(false);
});
