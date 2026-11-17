import { AgentsInTheCloudCoreError, createAgentsInTheCloudEventBus, type AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { CableTopics, type WorkspaceAgentTabProvider, type WorkspaceModule } from "@agents-in-the-cloud/shared";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createWebApp, type WebApp } from "../src/server/app.ts";
import { workspaceModules } from "../src/server/workspace-modules.generated.ts";
import { createWorkspaceRegistry, type WorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { workspaceWarnings } from "../src/server/workspace-warnings.ts";

interface TestConversation {
  id: string;
  title: string;
}

interface TestAgentModule {
  module: WorkspaceModule;
  conversations: TestConversation[];
  listedWorkspaceIds: string[];
  rendered: Array<{ workspaceId: string; agentId: string }>;
  closed: Array<{ workspaceId: string; agentId: string }>;
}

interface TestAppContext {
  app: WebApp;
  events: AgentsInTheCloudEventBus;
  registry: WorkspaceRegistry;
  agent: TestAgentModule;
  workspaceId: string;
}


function createTestAgentModule(initial: TestConversation[], created: TestConversation | TestConversation[] = { id: "conversation-new", title: "New Agent" }): TestAgentModule {
  const conversations = initial.map((conversation) => ({ ...conversation }));
  const creations = (Array.isArray(created) ? created : [created]).map((conversation) => ({ ...conversation }));
  const listedWorkspaceIds: string[] = [];
  const rendered: Array<{ workspaceId: string; agentId: string }> = [];
  const closed: Array<{ workspaceId: string; agentId: string }> = [];
  const tabs: WorkspaceAgentTabProvider = {
    async list({ workspaceId }) {
      listedWorkspaceIds.push(workspaceId);
      return conversations.map(({ id, title }) => ({ id, title }));
    },
    async render(context) {
      const conversation = conversations.find((candidate) => candidate.id === context.agentId);
      if (!conversation) throw new AgentsInTheCloudCoreError("agent_not_found", `Agent not found: ${context.agentId}`);
      rendered.push(context);
      return { html: `<article data-rendered-conversation="${conversation.id}">${conversation.title} body</article>` };
    },
    async close(context) {
      const index = conversations.findIndex((candidate) => candidate.id === context.agentId);
      if (index < 0) throw new AgentsInTheCloudCoreError("agent_not_found", `Agent not found: ${context.agentId}`);
      conversations.splice(index, 1);
      closed.push(context);
    },
  };
  const module: WorkspaceModule = {
    id: "test-agent",
    agentType: {
      id: "builtin", label: "Builtin", iconHtml: "", tabs,
      async create() {
        const conversation = creations.shift()!;
        conversations.push(conversation);
        return conversation.id;
      },
      launch: {
        async renderFooter() { return ""; }, async prepare() { return undefined; },
        async submit() { throw new Error("not used"); }, async prepareWorkspace() {},
      },
    },
  };
  return { module, conversations, listedWorkspaceIds, rendered, closed };
}

async function withTestApp(
  initial: TestConversation[],
  run: (context: TestAppContext) => Promise<void>,
  created?: TestConversation | TestConversation[],
  additionalModules: WorkspaceModule[] = [],
  deps: { persistWorkspaceParked?: (id: string, parked: boolean) => Promise<void> } = {},
): Promise<void> {
  const previousDataDir = process.env.ATELIER_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-app-agent-routes-"));
  const originalModules = workspaceModules.splice(0, workspaceModules.length);
  const agent = createTestAgentModule(initial, created);
  process.env.ATELIER_DATA_DIR = dataDir;
  workspaceModules.push(agent.module, ...additionalModules);
  try {
    const registry = createWorkspaceRegistry();
    const events = createAgentsInTheCloudEventBus();
    const app = createWebApp({
      registry,
      events,
      provisionWorkspace: async () => {},
      deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" },
      destroyWorkspace: async () => {},
      persistWorkspaceParked: deps.persistWorkspaceParked ?? (async () => {}),
      logError: () => {},
    });
    const workspaceId = "workspace-agent-routes";
    await registry.seed([{ id: workspaceId, title: "Agent routes" }]);
    await Bun.sleep(0);
    await run({ app, events, registry, agent, workspaceId });
  } finally {
    workspaceModules.splice(0, workspaceModules.length, ...originalModules);
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe("Agent type app integration", () => {
  test("automation retains command schemas and lists host agent commands once", async () => {
    const inputSchema = Type.Object({ value: Type.String() });
    await withTestApp([], async ({ app, workspaceId }) => {
      const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}`, { headers: { accept: "application/json" } }));
      const { workspace } = await response.json();
      expect(workspace.commands.find((command: { id: string }) => command.id === "test.command").inputSchema).toEqual(JSON.parse(JSON.stringify(inputSchema)));
      expect(workspace.commands.map((command: { id: string }) => command.id)).toEqual(["test.command", "agent.create", "agent.create.builtin"]);
    }, undefined, [{
      id: "test-command",
      commands: [{ id: "test.command", execute() { return {}; } }],
      attachToWorkspace() { return { commands: [{ id: "test.command", label: "Test command", scope: "workspace", inputSchema }] }; },
    }]);
  });

  test("warning dismissal does not attach modules or list Agents", async () => {
    await withTestApp([{ id: "conversation-a", title: "Alpha" }], async ({ app, agent, registry, workspaceId }) => {
      registry.setWarning(workspaceId, "preparation", "Gateway unavailable");
      const warning = workspaceWarnings(registry.get(workspaceId)!, undefined)[0]!;
      const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/warnings/preparation/dismiss`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ state: warning.state }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ dismissed: true });
      expect(agent.listedWorkspaceIds).toEqual([]);
    }, undefined, [{ id: "must-not-attach", attachToWorkspace() { throw new Error("Warning dismissal attached a module"); } }]);
  });

});

for (const operation of ["createWorkView", "presentWorkViewFromAgent"] as const) {
  test(`${operation} initializes Work views without a prior workspace read`, async () => {
    const types = ["default-view", "requested-view", "unopened-view"];
    const module: WorkspaceModule = {
      id: "test-work-views",
      workViews: types.map(type => ({
        type,
        parseReference: () => ({ type }),
        identity: () => "workspace",
        render: async () => "",
      })),
      attachToWorkspace: () => ({
        workViews: types.map(type => ({
          reference: { type }, sourceKey: `${type}:workspace`, label: type, kind: "resource" as const,
          availability: { phase: "live" as const }, initiallyOpen: type === "default-view",
        })),
      }),
    };
    await withTestApp([], async ({ app, workspaceId, agent }) => {
      await app[operation](workspaceId, { type: "requested-view" });
      await app[operation](workspaceId, { type: "requested-view" });
      const state = JSON.parse(await readFile(join(process.env.ATELIER_DATA_DIR!, "workspaces", workspaceId, "metadata", "presentation.json"), "utf8"));
      expect(state.workViews).toEqual([
        { reference: { type: "default-view" } },
        { reference: { type: "requested-view" } },
      ]);
      expect(agent.listedWorkspaceIds).toEqual([]);
      expect(agent.rendered).toEqual([]);
    }, undefined, [module]);
  });
}

test("the workspace chrome renders no Agent pane; each pane's own surface renders it", async () => {
  await withTestApp([{ id: "conversation-a", title: "Alpha" }, { id: "conversation-b", title: "Beta" }], async ({ app, agent, workspaceId }) => {
    const chrome = await app.subscribeSurface(CableTopics.module("surface", workspaceId, { kind: "workspace" }), () => {});
    expect(agent.rendered).toEqual([]);
    const published: string[] = [];
    const pane = await app.subscribeSurface(CableTopics.module("surface", workspaceId, { kind: "agent-pane", key: "conversation-b" }), html => published.push(html));
    expect(agent.rendered).toEqual([{ workspaceId, agentId: "conversation-b" }]);
    expect(published.join("")).toContain('data-rendered-conversation="conversation-b"');
    const closed = await app.subscribeSurface(CableTopics.module("surface", workspaceId, { kind: "agent-pane", key: "conversation-closed" }), () => {});
    expect(agent.rendered).toHaveLength(1);
    for (const subscription of [chrome, pane, closed]) subscription.unsubscribe();
  });
});

test("a selected Agent pane stops rendering once its workspace leaves the running phase", async () => {
  await withTestApp([{ id: "conversation-a", title: "Alpha" }], async ({ app, agent, registry, workspaceId }) => {
    const pane = await app.subscribeSurface(CableTopics.module("surface", workspaceId, { kind: "agent-pane", key: "conversation-a" }), () => {});
    const rendered = agent.rendered.length;
    registry.setDeletion(workspaceId, { status: "checking" });
    await Bun.sleep(20);
    expect(agent.rendered.length).toBe(rendered);
    pane.unsubscribe();
  });
});

test("a selected Agent pane does not render while its workspace is being parked", async () => {
  const stop = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const persistWorkspaceParked = async (_id: string, parked: boolean) => { if (parked) { stopping.resolve(); await stop.promise; } };
  await withTestApp([{ id: "conversation-a", title: "Alpha" }], async ({ app, agent, events, workspaceId }) => {
    const pane = await app.subscribeSurface(CableTopics.module("surface", workspaceId, { kind: "agent-pane", key: "conversation-a" }), () => {});
    const rendered = agent.rendered.length;
    const parking = app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/park?force=1`, { method: "POST", headers: { accept: "application/json" } }));
    await stopping.promise;
    void events.emit("workspace_agent_title_changed", { workspaceId: "another-workspace", agentId: "x", title: "y" });
    await Bun.sleep(20);
    expect(agent.rendered.length).toBe(rendered);
    stop.resolve();
    expect((await parking).status).toBe(200);
    pane.unsubscribe();
  }, undefined, [], { persistWorkspaceParked });
});

test("a workspace command refreshes each contributed live resource once", async () => {
  let loads = 0;
  await withTestApp([], async ({ app, workspaceId }) => {
    await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}`, { headers: { accept: "application/json" } }));
    const subscription = await app.subscribeSurface({ channel: "module", name: "surface", workspaceId, params: { kind: "test-resource" } }, () => {});
    expect(loads).toBe(1);
    const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/commands/test.update`, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(200);
    await Bun.sleep(0);
    expect(loads).toBe(2);
    subscription.unsubscribe();
  }, undefined, [{
    id: "test-updates",
    commands: [{ id: "test.update", execute: () => ({}) }],
    liveSurfaces: [{ name: "test-resource", async load() { loads++; return []; } }],
  }]);
});

test("the theme is a server setting pushed to every open page", async () => {
  await withTestApp([], async ({ app }) => {
    const pushed: string[] = [];
    const subscription = await app.subscribeShell((html) => pushed.push(html));
    const response = await app.fetch(new Request("http://test.local/settings/theme", {
      method: "POST", headers: { accept: "text/vnd.turbo-stream.html" }, body: new URLSearchParams({ theme: "tokyo-night" }),
    }));
    expect(response.status).toBe(200);
    await Bun.sleep(10);
    expect(pushed.join("")).toContain('data-agents-in-the-cloud-theme-name-value="tokyo-night"');
    expect(JSON.parse(await readFile(join(process.env.ATELIER_DATA_DIR!, "theme.json"), "utf8"))).toEqual({ theme: "tokyo-night" });
    const settings = await (await app.fetch(new Request("http://test.local/settings/sections/theme"))).text();
    expect(settings).toContain('<option value="tokyo-night" selected>');
    const rejected = await app.fetch(new Request("http://test.local/settings/theme", { method: "POST", body: new URLSearchParams({ theme: "neon" }) }));
    expect(rejected.status).toBe(400);
    subscription.unsubscribe();
  });
});
