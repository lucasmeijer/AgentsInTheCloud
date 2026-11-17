import { listWorkspaceAgents, type AgentRouteHandler } from "@agents-in-the-cloud/builtin-agent/server";
import { requestAcceptsJson } from "@agents-in-the-cloud/core";
import { nativeSnapshot } from "./native-view-state.ts";

export const handleSubagentRequest: AgentRouteHandler = async (request, url) => {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/subagents$/);
  if (!match || request.method !== "GET" || !requestAcceptsJson(request)) return undefined;
  const workspaceId = decodeURIComponent(match[1]!);
  const roots = await listWorkspaceAgents(workspaceId);
  const parentId = url.searchParams.get("agent") ?? roots[0]?.agentId;
  const parent = roots.find((agent) => agent.agentId === parentId);
  if (!parent) return new Response("Agent not found", { status: 404 });
  const snapshot = await nativeSnapshot(workspaceId);
  const agents = snapshot.agents.filter(agent => agent.rootId === parent.agentId);
  return Response.json({ parent: { id: parentId, title: parent.title }, agents, messages: snapshot.messages.filter((message) => message.to === parentId || message.from === parentId || agents.some((agent) => agent.id === message.to || agent.id === message.from)) });
};
