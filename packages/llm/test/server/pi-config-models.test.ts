import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomModelsJson, getEnabledModels, loginPiOAuthProvider, readGitHubCopilotUsageToken, setCustomModelsJson, setEnabledModels, validateModelProviderApiKey } from "../../src/server/pi-config-models.ts";
import { updateJsonSettings } from "@agents-in-the-cloud/core/json-settings";
let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-llm-models-"));
  process.env.ATELIER_DATA_DIR = dataDir;
});
afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

test("Copilot usage reads the stored GitHub token, never the inference or repository token", async () => {
  const path = join(dataDir, "pi-config", "auth.json");
  expect(await readGitHubCopilotUsageToken()).toBeUndefined();
  await updateJsonSettings(path, stored => {
    stored["github-copilot"] = { type: "oauth", access: "inference-token", refresh: "github-oauth-token", expires: 0 };
    stored.github = { type: "api_key", key: "repository-token" };
  });
  const before = await readFile(path, "utf8");
  expect(await readGitHubCopilotUsageToken()).toBe("github-oauth-token");
  expect(await readFile(path, "utf8")).toBe(before);
  await updateJsonSettings(path, stored => { stored["github-copilot"] = { type: "api_key", key: "api-token" }; });
  expect(await readGitHubCopilotUsageToken()).toBeUndefined();
});

describe("API key validation", () => {
  test("OpenCode Go probes carry the session header OpenCode requires for routing", async () => {
    const realFetch = globalThis.fetch;
    const sessions: (string | null)[] = [];
    globalThis.fetch = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
      sessions.push(new Request(input, init).headers.get("x-opencode-session"));
      return Response.json({ type: "MissingSessionID" }, { status: 400 });
    }, { preconnect: realFetch.preconnect });
    try {
      await expect(validateModelProviderApiKey("opencode-go", "test-key")).rejects.toThrow();
      await expect(validateModelProviderApiKey("opencode-go", "test-key")).rejects.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const session of sessions) expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(sessions).size).toBeGreaterThan(1);
  });
});

describe("enabled model storage", () => {
  test("reads the older saved list and writes enabledModels without losing other settings", async () => {
    const path = join(dataDir, "pi-config", "models.json");
    const model = { provider: "example", id: "first", label: "First" };
    await updateJsonSettings(path, stored => {
      stored.picker = [model];
      stored.otherOwner = { retained: true };
    });
    expect(await getEnabledModels()).toEqual([model]);
    await setEnabledModels([model]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.enabledModels).toEqual([model]);
    expect(saved.picker).toBeUndefined();
    expect(saved.otherOwner).toEqual({ retained: true });
  });

  test("an explicitly empty enabled list takes precedence over the older saved list", async () => {
    const path = join(dataDir, "pi-config", "models.json");
    await updateJsonSettings(path, stored => {
      stored.enabledModels = [];
      stored.picker = [{ provider: "example", id: "old", label: "Old" }];
    });
    expect(await getEnabledModels()).toEqual([]);
    await setEnabledModels([]);
    expect(JSON.parse(await readFile(path, "utf8")).enabledModels).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8")).picker).toBeUndefined();
  });
});

describe("custom Pi model configuration", () => {
  test("rejects malformed JSON and invalid Pi model definitions without replacing saved configuration", async () => {
    const valid = JSON.stringify({ providers: { "openai-codex": { models: [{ id: "future-model" }] } } });
    await setCustomModelsJson(valid);

    expect(setCustomModelsJson("{ broken")).rejects.toThrow("Invalid JSON");
    expect(setCustomModelsJson(JSON.stringify({ providers: { "openai-codex": { models: [{ id: 42 }] } } }))).rejects.toThrow("must be string");
    expect(JSON.parse(await getCustomModelsJson())).toEqual(JSON.parse(valid));
  });

  test("retains pasted definitions but omits models supplied by the official catalogue", async () => {
    const source = JSON.stringify({
      providers: {
        "openai-codex": {
          models: [
            { id: "gpt-5.5", name: "Stale custom copy" },
            { id: "future-model", name: "Future model" },
          ],
        },
      },
    });

    const result = await setCustomModelsJson(source);
    const effective = JSON.parse(await readFile(join(dataDir, "pi-config", "models.json"), "utf8"));

    expect(result.skippedOfficialModels).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
    expect(effective.providers["openai-codex"].models).toEqual([{ id: "future-model", name: "Future model" }]);
    expect(JSON.parse(await getCustomModelsJson()).providers["openai-codex"].models).toHaveLength(2);
  });

  test("Sign in with ChatGPT identifies this installation by one stable device ID", async () => {
    async function agentHostId(): Promise<string | null> {
      const abort = new AbortController();
      let authUrl: string | undefined;
      await expect(loginPiOAuthProvider("openai", {
        signal: abort.signal,
        notify: (event) => { if (event.type === "auth_url") authUrl = event.url; },
        // Reject the prompt so the provider reaches its cleanup before we start
        // another login. Aborting in notify races the prompt's abort listener.
        prompt: async () => { throw new Error("cancelled by test"); },
      })).rejects.toThrow("cancelled by test");
      return new URL(authUrl!).searchParams.get("ext_agent_host_id");
    }
    const first = await agentHostId();
    expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(await agentHostId()).toBe(first);
  });
});
