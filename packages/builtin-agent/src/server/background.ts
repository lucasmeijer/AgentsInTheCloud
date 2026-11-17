import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { refreshingBackgroundDetail, renderBackgroundActivities, renderBackgroundGone, renderBackgroundPage, type BackgroundActivity } from "@agents-in-the-cloud/agent/server/background-activity";
import { ids, type AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import { createLivePresentation, escapeHtml } from "@agents-in-the-cloud/shared";
import { response } from "@agents-in-the-cloud/shared/http";
import { listWorkspaceAgents } from "./agent-store.ts";
import { commitDurableStop, markGatedDurableWork, settleStoppedDurableWork } from "./durable-lifecycle.ts";
import { WorkspaceAgents } from "./durable-workspace.ts";
import { builtinAgentIntegrations, type BackgroundActivitySource } from "./integrations.ts";
import { durableWorkspaceOwner } from "./runtime.ts";
import type { AgentLivePresentationSubscription } from "./runtime-types.ts";

export const backgroundChannelName = "agent-background";

function sources(): BackgroundActivitySource[] {
  return builtinAgentIntegrations().flatMap(integration => integration.background ? [integration.background] : []);
}

async function activities(workspaceId: string, rootId: string) {
  const lists = await Promise.all(sources().map(async source => (await source.activities(workspaceId, rootId)).map(activity => ({ activity, source }))));
  return lists.flat();
}

export function renderBackgroundControl(ctx: AgentRenderContext): string {
  if (!sources().length) return "";
  return `<div hidden data-controller="builtin-background" data-builtin-background-workspace-id-value="${escapeHtml(ctx.workspaceId)}" data-builtin-background-agent-id-value="${escapeHtml(ctx.agentId)}"
    data-action="agents-in-the-cloud:workspace-agent-selected@document->builtin-background#sync agents-in-the-cloud:workspace-pane-visible@document->builtin-background#sync agents-in-the-cloud:workspace-pane-hidden@document->builtin-background#sync visibilitychange@document->builtin-background#sync"></div>`;
}

export async function subscribeBackground(workspaceId: string, rootId: string, listener: (html: string) => void): Promise<AgentLivePresentationSubscription> {
  const roots = await listWorkspaceAgents(workspaceId);
  if (!roots.some((root) => root.agentId === rootId)) throw new Error(`Agent not found: ${rootId}`);
  const owner = await durableWorkspaceOwner(workspaceId);
  let listed: BackgroundActivity[] = [];
  const ctx = { workspaceId, agentId: rootId };
  const presentation = createLivePresentation(() => [{ target: ids.background(ctx), html: renderBackgroundActivities(ctx, listed) }]);
  let updates = Promise.resolve();
  const refresh = () => updates = updates.then(async () => { listed = (await activities(workspaceId, rootId)).map(item => item.activity); presentation.invalidate(); });
  const watches = await Promise.all([owner.harness.watchDoc(WorkspaceAgents, BACKGROUND_CONTEXT), owner.harness.watchTaskGraph(BACKGROUND_CONTEXT)]);
  for (const watch of watches) watch?.start(refresh);
  const stops = await Promise.all(sources().flatMap(source => source.watch ? [source.watch(owner.harness, refresh)] : []));
  await refresh();
  const subscription = presentation.subscribe(listener);
  return { unsubscribe() {
    for (const watch of watches) void watch?.stop();
    for (const stop of stops) void stop();
    subscription.unsubscribe();
    presentation.dispose();
  } };
}

export function childAgentTranscriptHtml(workspaceId: string, agentId: string): string {
  return `<div class="agent-transcript-content" id="${ids.transcript({ workspaceId, agentId })}" data-turbo-permanent data-controller="builtin-child-transcript" data-builtin-child-transcript-workspace-id-value="${escapeHtml(workspaceId)}" data-builtin-child-transcript-agent-id-value="${escapeHtml(agentId)}"
    data-action="click->builtin-child-transcript#follow agents-in-the-cloud:workspace-agent-selected@document->builtin-child-transcript#sync agents-in-the-cloud:workspace-pane-visible@document->builtin-child-transcript#sync agents-in-the-cloud:workspace-pane-hidden@document->builtin-child-transcript#sync visibilitychange@document->builtin-child-transcript#sync"></div>`;
}

export async function stopChildAgent(workspaceId: string, agentId: string): Promise<void> {
  const owner = await durableWorkspaceOwner(workspaceId);
  const record = (await owner.catalog()).find(record => record.agentId === agentId)!;
  await owner.harness.commit(tx => commitDurableStop(tx, record.durableId), BACKGROUND_CONTEXT);
  await markGatedDurableWork(owner.harness);
  await settleStoppedDurableWork(owner.harness);
}

export async function handleBackgroundRequest(request: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/background\/([^/]+)(\/stop)?$/);
  if (!match || !sources().length) return undefined;
  const workspaceId = decodeURIComponent(match[1]!);
  const key = decodeURIComponent(match[3]!);
  const agentId = decodeURIComponent(match[2]!);
  const record = (await (await durableWorkspaceOwner(workspaceId)).catalog()).find(record => record.agentId === agentId);
  const rootId = record?.rootId ?? agentId;
  const ctx: AgentRenderContext = { workspaceId, agentId: rootId };
  const found = (await activities(workspaceId, rootId)).find(item => item.activity.key === key);
  if (match[4] && request.method === "POST") {
    if (found?.activity.running) await found.source.stop(workspaceId, found.activity);
    return new Response(null, { status: 204 });
  }
  if (match[4] || request.method !== "GET") return undefined;
  if (!found) return response(renderBackgroundGone(ctx, key, true));
  return response(renderBackgroundPage(ctx, found.activity, refreshingBackgroundDetail(found.activity, await found.source.detail(workspaceId, rootId, found.activity))));
}
