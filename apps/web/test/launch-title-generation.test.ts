import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as agent from "@agents-in-the-cloud/builtin-agent/server";
import { agentsInTheCloudServerModule as codexCliModule } from "@agents-in-the-cloud/codex-cli-agent/server";
import { agentsInTheCloudServerModule as codexModule } from "@agents-in-the-cloud/codex-agent/server";
import { createTestApp, deferred, postJson, temporaryAgentsInTheCloudDataDir } from "./support/test-web-app.ts";

const data = temporaryAgentsInTheCloudDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

describe("launch title generation", () => {
  test.each([
    { agentTypeId: "builtin", launch: agent.nativeAgentLaunch, model: "provider::model" },
    { agentTypeId: "codex", launch: codexModule.agentType!.launch, model: "openai-codex::gpt-5.4" },
    { agentTypeId: "codex-cli", launch: codexCliModule.agentType!.launch, model: "openai-codex::gpt-5.4" },
  ])("names $agentTypeId from the launch prompt after provisioning without an Agent", async ({ agentTypeId, launch, model }) => {
    const prepare = spyOn(launch, "prepare").mockImplementation(async (parameters) => ({ agent: { initialPrompt: String(parameters?.initialPrompt ?? ""), model: String(parameters?.model ?? "") } }));
    const name = spyOn(agent, "maybeNameWorkspaceFromPrompt").mockImplementation(() => {});
    try {
      const ready = deferred();
      const { app, registry } = createTestApp({ provision: () => ready.promise });
      const response = await app.fetch(postJson("/workspaces", {
        agent: { agentTypeId, initialPrompt: "Build a calendar", model },
      }));
      expect(response.status).toBe(202);
      const { workspace } = await response.json();
      expect(name).not.toHaveBeenCalled();
      ready.resolve();
      await Bun.sleep(0);
      expect(registry.get(workspace.id)?.phase.kind).toBe("runningPhase");
      expect(name).toHaveBeenCalledTimes(1);
      expect(name).toHaveBeenCalledWith(workspace.id, "Build a calendar", {
        events: undefined, agentModel: { provider: model.split("::")[0], id: model.split("::")[1] }, onFailure: expect.any(Function),
      });
    } finally {
      prepare.mockRestore();
      name.mockRestore();
    }
  });

  test("a failed naming request becomes a workspace warning that naming clears", async () => {
    const prepare = spyOn(agent.nativeAgentLaunch, "prepare").mockImplementation(async (parameters) => ({ agent: { initialPrompt: String(parameters?.initialPrompt ?? ""), model: String(parameters?.model ?? "") } }));
    const name = spyOn(agent, "maybeNameWorkspaceFromPrompt").mockImplementation((_workspaceId, _prompt, options) => options?.onFailure?.("model authentication is not configured"));
    try {
      const { app, registry } = createTestApp();
      const { workspace } = await (await app.fetch(postJson("/workspaces", { agent: { initialPrompt: "Build a calendar", model: "provider::model" } }))).json();
      await Bun.sleep(0);
      expect(registry.get(workspace.id)?.issues).toEqual([{ kind: "naming", message: "Couldn't name this workspace (model authentication is not configured). You can name it with /name in the AgentsInTheCloud composer." }]);
      registry.setTitle(workspace.id, "calendar");
      expect(registry.get(workspace.id)?.issues).toBeUndefined();
    } finally {
      prepare.mockRestore();
      name.mockRestore();
    }
  });

  test("a promptless launch leaves naming to later message submission", async () => {
    const name = spyOn(agent, "maybeNameWorkspaceFromPrompt").mockImplementation(() => {});
    try {
      const { app } = createTestApp();
      expect((await app.fetch(postJson("/workspaces", {}))).status).toBe(202);
      await Bun.sleep(0);
      expect(name).not.toHaveBeenCalled();
    } finally {
      name.mockRestore();
    }
  });

  test("failed provisioning does not request a title", async () => {
    const prepare = spyOn(agent.nativeAgentLaunch, "prepare").mockImplementation(async (parameters) => ({ agent: { initialPrompt: String(parameters?.initialPrompt ?? ""), model: String(parameters?.model ?? "") } }));
    const name = spyOn(agent, "maybeNameWorkspaceFromPrompt").mockImplementation(() => {});
    try {
      const { app } = createTestApp({ provision: async () => { throw new Error("provision failed"); } });
      expect((await app.fetch(postJson("/workspaces", { agent: { initialPrompt: "Build a calendar" } }))).status).toBe(202);
      await Bun.sleep(0);
      expect(name).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      name.mockRestore();
    }
  });
});
