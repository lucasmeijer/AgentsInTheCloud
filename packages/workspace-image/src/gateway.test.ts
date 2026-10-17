import { test } from "bun:test";
import { runGoTests } from "@agents-in-the-cloud/core";
import { fileURLToPath } from "node:url";

test("the gateway's Go tests pass", () => runGoTests(fileURLToPath(new URL("../workspace-image/gateway", import.meta.url))), 120_000);
