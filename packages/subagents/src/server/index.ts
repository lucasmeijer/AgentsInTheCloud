import type { WorkspaceModule } from "@agents-in-the-cloud/shared";
import { registerAgentToolPresentations } from "@agents-in-the-cloud/agent/server";
import { listWorkspaceAgents, configureAgentDelegation, registerBuiltinAgentIntegration } from "@agents-in-the-cloud/builtin-agent/server";
import { createNativeDelegationExtension } from "./native-runtime.ts";
import { delegationModels, stampDelegationRequestIdentity } from "./native-models.ts";
import { nativeDelegationTranscript } from "./native-transcript.ts";
import { attributedEntry } from "./native-state.ts";
import { nativeToolPresentations } from "./native-tool-presentation.ts";
import { nativeSnapshot } from "./native-view-state.ts";
import { handleSubagentRequest } from "./subagent-view.ts";
import { subagentBackground } from "./background.ts";
import { subagentsOpenApiPaths } from "./openapi.ts";

export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "subagents",
  initialize() {
    configureAgentDelegation({
      create(models, harness) { return { extension: createNativeDelegationExtension(harness), models: delegationModels(models, harness) }; },
      requestMessages: stampDelegationRequestIdentity,
      attributed: attributedEntry,
    });
    registerAgentToolPresentations(nativeToolPresentations);
    registerBuiltinAgentIntegration({ id: "subagents", transcript: nativeDelegationTranscript, background: subagentBackground });
  },
  staticFiles: { "/subagents.css": { url: new URL("../client/subagents.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  openApiPaths: subagentsOpenApiPaths,
  routes: [{
    async handle(request, url, context) {
      const reveal = url.pathname.match(/^\/workspaces\/([^/]+)\/subagents\/reveal$/);
      if (reveal && (request.method === "POST" || request.method === "GET")) {
        const workspaceId = decodeURIComponent(reveal[1]!);
        const form = request.method === "GET" ? url.searchParams : await request.formData();
        const snapshot = await nativeSnapshot(workspaceId);
        const target = String(form.get("child"));
        const child = snapshot.agents.find((agent) => agent.id === target);
        const message = snapshot.messages.find((message) => message.id === String(form.get("message")));
        if (!message || (message.from !== target && message.to !== target)) return new Response("Subagent message not found", { status: 404 });
        if (!child) {
          const roots = await listWorkspaceAgents(workspaceId);
          if (!roots.some((root) => root.agentId === target)) return new Response("Agent not found", { status: 404 });
          const query = new URLSearchParams({ agent: target, agentTarget: message.id });
          return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${query}` } });
        }
        const query = new URLSearchParams({ agent: child.rootId, background: child.id, message: message.id });
        return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${query}` } });
      }
      return handleSubagentRequest(request, url, { events: context.events });
    },
  }],
};
