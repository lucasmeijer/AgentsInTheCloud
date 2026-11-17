import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const realFetch = globalThis.fetch;
let directory: string | undefined;
afterEach(async () => {
  globalThis.fetch = realFetch;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("Anthropic offers a headless login that uses Anthropic's copy-code page instead of a localhost callback", async () => {
  directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-anthropic-copy-code-"));
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: join(directory, "models.json"), allowModelNetwork: false });
  const tokenRequests: unknown[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://platform.claude.com/v1/oauth/token");
    tokenRequests.push(JSON.parse(String(init?.body)));
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  }, { preconnect: realFetch.preconnect });

  let authUrl: URL | undefined;
  await runtime.login("anthropic", "oauth", {
    notify: (event) => { if (event.type === "auth_url") authUrl = new URL(event.url); },
    prompt: async (prompt) => {
      if (prompt.type === "select") return prompt.options.find((option) => /headless/i.test(option.label ?? ""))!.id;
      expect(prompt.type).toBe("manual_code");
      return `pasted-code#${authUrl!.searchParams.get("state")}`;
    },
  });

  expect(authUrl!.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
  const request = Value.Parse(Type.Object({ code: Type.String(), state: Type.String(), redirect_uri: Type.String() }), tokenRequests[0]);
  expect(request).toMatchObject({ code: "pasted-code", state: authUrl!.searchParams.get("state")!, redirect_uri: "https://platform.claude.com/oauth/code/callback" });
  expect(await credentials.read("anthropic")).toMatchObject({ type: "oauth", access: "access", refresh: "refresh" });
});
