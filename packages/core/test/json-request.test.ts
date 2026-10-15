import { expect, test } from "bun:test";
import { isJsonObject, readJsonObject } from "../src/json-request.ts";

test("JSON object validation preserves nested extension data without accepting non-JSON values", () => {
  const value = { text: "λ", count: 42, enabled: true, missing: null, nested: [{ values: [false, 0, ""] }] };
  expect(isJsonObject(value)).toBe(true);
  expect(isJsonObject({})).toBe(true);
  for (const invalid of [null, [], "text", undefined, { value: undefined }, { value: NaN }, { value: Infinity },
    { nested: [{ callback() {} }] }, { nested: [{ value: 1n }] }]) {
    expect(isJsonObject(invalid)).toBe(false);
  }
  // A failed check must not affect later values checked by the same validator.
  expect(isJsonObject(value)).toBe(true);
});

test("HTTP JSON input still rejects invalid JSON and non-object bodies", async () => {
  const request = (body: string) => new Request("http://localhost/", { method: "POST", body });
  await expect(readJsonObject(request('{"nested":{"value":1}}'))).resolves.toEqual({ nested: { value: 1 } });
  await expect(readJsonObject(request("[1,2]"))).rejects.toThrow("JSON object body is required");
  await expect(readJsonObject(request("{"))).rejects.toThrow("valid JSON object body is required");
});
