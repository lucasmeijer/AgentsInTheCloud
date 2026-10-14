import { expect, test } from "bun:test";
import { Type } from "typebox";
import { nativeJsonlRows } from "../src/server/native-transcript.ts";

const schema = Type.Object({ id: Type.String(), message: Type.Object({ text: Type.String() }) });
const row = { id: "one", message: { text: "λ🦋" } };

test("native JSONL validates each row, keeps unknown fields, and ignores a torn last line", () => {
  const extended = { ...row, producerField: { retained: true } };
  const jsonl = [JSON.stringify(extended), "", "null", JSON.stringify({ id: "bad", message: { text: 42 } }), JSON.stringify(row), '{"id":'].join("\n");
  expect([...nativeJsonlRows(jsonl, schema)]).toEqual([extended, row]);
  expect([...nativeJsonlRows(JSON.stringify(row), schema)]).toEqual([row]);
  expect(() => [...nativeJsonlRows('{"id":\n' + JSON.stringify(row), schema)]).toThrow();
});

test("a long history is fully validated and a later read uses its own schema", () => {
  const count = 20_000;
  const jsonl = Array.from({ length: count }, (_, index) => JSON.stringify({ ...row, id: String(index) })).join("\n");
  const rows = [...nativeJsonlRows(jsonl, schema)];
  expect(rows).toHaveLength(count);
  expect(rows[0]?.id).toBe("0");
  expect(rows.at(-1)?.id).toBe(String(count - 1));
  expect([...nativeJsonlRows(jsonl, Type.Object({ id: Type.Number() }))]).toEqual([]);
});
