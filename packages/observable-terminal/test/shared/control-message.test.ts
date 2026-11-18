import { expect, test } from "bun:test";
import { parseObservableTerminalMessage } from "../../src/shared/index.ts";

test("terminal control messages validate JSON objects and their fields", () => {
  expect(parseObservableTerminalMessage('{"type":"resize","cols":80,"rows":24}')).toEqual({ type: "resize", cols: 80, rows: 24 });
  expect(parseObservableTerminalMessage('{"type":"progress","state":2,"value":50}')).toEqual({ type: "progress", state: 2, value: 50 });
  for (const text of ["null", "[]", "42", "invalid", '{"type":"resize","cols":0,"rows":24}', '{"type":"progress","state":5}']) {
    expect(parseObservableTerminalMessage(text)).toBeUndefined();
  }
});

test("terminal shared code bundles for browsers without Node builtins", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../../src/shared/index.ts", import.meta.url).pathname],
    target: "browser",
    plugins: [{
      name: "reject-server-imports",
      setup(build) {
        build.onResolve({ filter: /^node:/ }, ({ path }) => { throw new Error(`Browser code imports ${path}`); });
      },
    }],
  });
  expect(result.success).toBe(true);
});
