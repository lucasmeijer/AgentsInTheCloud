import { agentKey, ids, type AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import { renderReadOnlyTranscript, renderReadOnlyTranscriptDetail } from "@agents-in-the-cloud/agent/server/read-only-transcript";
import { subscribeWorkspaceAgentBusy } from "@agents-in-the-cloud/agent/server";
import { renderWorkspaceCompletionCatalog } from "@agents-in-the-cloud/agent/server/completion-catalog";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { renderFollowLatestButton } from "@agents-in-the-cloud/prompt/server";
import { domId, escapeHtml, turboStream, type CableChannelAdapter } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { response } from "@agents-in-the-cloud/shared/http";
import type { CliAgentAdapter } from "./adapter.ts";
import type { CliAgents } from "./agents.ts";

type CliTranscriptContext = AgentRenderContext & { transcriptBasePath: string };
function context(workspaceId: string, agentId: string, providerId: string): CliTranscriptContext {
  return { workspaceId, agentId, transcriptBasePath: `/workspaces/${encodeURIComponent(workspaceId)}/${providerId}-agents/${encodeURIComponent(agentId)}/transcript` };
}

function renderTranscriptContent(ctx: CliTranscriptContext, available: boolean, html = ""): string {
  return `<div id="${ids.transcript(ctx)}" class="agent-transcript-content" data-cli-terminal-target="transcriptContent" data-available="${available}">${html}</div>`;
}

export function renderCliTranscriptView(adapter: CliAgentAdapter, workspaceId: string, agentId: string): string {
  if (!adapter.loadTranscript) return "";
  return `<div class="agent-transcript cli-transcript-view" tabindex="0" role="region" aria-label="Agent transcript" data-cli-terminal-target="transcript" data-action="scroll->cli-terminal#transcriptScrolled">${renderTranscriptContent(context(workspaceId, agentId, adapter.id), false)}</div>`;
}

export function cliTranscriptAttributes(adapter: CliAgentAdapter, agentId: string): string {
  if (!adapter.loadTranscript) return "";
  return `data-cli-terminal-agent-id-value="${escapeHtml(agentId)}" data-cli-terminal-transcript-channel-value="${escapeHtml(cliTranscriptChannelName(adapter))}"`;
}

export function cliCompletionCatalogId(workspaceId: string, agentId: string): string { return domId("cli_catalog", workspaceId, agentId); }

function cliTranscriptChannelName(adapter: CliAgentAdapter): string { return `${adapter.id}-transcript`; }

export function cliTranscriptChannel(adapter: CliAgentAdapter, agents: Pick<CliAgents, "ready">): CableChannelAdapter {
  const busy = new Set<string>();
  const watchers = new Set<{ agentKey: string; changed(): void }>();
  subscribeWorkspaceAgentBusy(({ agentKey, busy: started }) => {
    if (started) busy.add(agentKey); else busy.delete(agentKey);
    for (const watcher of watchers) if (watcher.agentKey === agentKey) watcher.changed();
  });
  async function render(workspaceId: string, agentId: string, includeTranscript: boolean): Promise<string> {
    const idle = !busy.has(agentKey(agentId));
    const [records, catalog] = idle ? await Promise.all([adapter.loadTranscript!(workspaceId, agentId), renderWorkspaceCompletionCatalog(workspaceId, "cli")]) : [];
    const available = records?.some((record) => record.kind === "user") ?? false;
    const ctx = context(workspaceId, agentId, adapter.id);
    const transcript = turboStream("replace", ids.transcript(ctx), renderTranscriptContent(ctx, available, includeTranscript && available ? renderReadOnlyTranscript(ctx, records!) : ""));
    return catalog === undefined ? transcript : `${transcript}${turboStream("update", cliCompletionCatalogId(workspaceId, agentId), catalog)}`;
  }
  return {
    name: cliTranscriptChannelName(adapter),
    async subscribe(identifier, listener) {
      if (identifier.channel !== "module" || identifier.name !== cliTranscriptChannelName(adapter)) throw new Error(`Invalid ${adapter.label} transcript channel`);
      const { agentId, transcript } = Value.Parse(Type.Object({ agentId: Type.String({ minLength: 1 }), transcript: Type.Optional(Type.Literal("shown")) }, { additionalProperties: false }), identifier.params);
      const workspaceId = identifier.workspaceId;
      await agents.ready(workspaceId, agentId);
      const publish = async () => listener(await render(workspaceId, agentId, transcript !== undefined));
      let latest = publish();
      const watcher = {
        agentKey: agentKey(agentId),
        changed() {
          latest = latest.then(publish).catch((error) => {
            console.error(`Could not publish ${adapter.label} transcript for ${agentId}`, error);
          });
        },
      };
      watchers.add(watcher);
      try { await latest; } catch (error) { watchers.delete(watcher); throw error; }
      return { unsubscribe: () => { watchers.delete(watcher); } };
    },
  };
}

interface CliTranscriptControls { viewSwitch?: string; followLatest?: string }

export function renderCliTranscriptControls(adapter: CliAgentAdapter): CliTranscriptControls {
  if (!adapter.loadTranscript) return {};
  return {
    viewSwitch: [
      { iconHtml: Icons.Transcript, label: "View transcript", state: "transcript", action: "showTranscript" },
      { iconHtml: Icons.Terminal, label: "Back to terminal", state: "terminal", action: "showTerminal" },
      { iconHtml: Icons.TranscriptPending, label: "Will autoswitch to transcript when agent is done", state: "pending", action: "showTerminal" },
    ].map(({ iconHtml, label, state, action }) => buttonHtml({
      type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml, label },
      attributesHtml: `data-popular-button data-cli-transcript-button="${state}" data-action="cli-terminal#${action}" aria-keyshortcuts="Meta+Alt+P"`,
    })).join(""),
    followLatest: renderFollowLatestButton('data-cli-terminal-target="transcriptEnd" data-action="cli-terminal#scrollToTranscriptEnd"'),
  };
}

export function cliTranscriptRoutes(adapter: CliAgentAdapter, agents: CliAgents) {
  return async (request: Request, url: URL): Promise<Response | undefined> => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)-agents\/([^/]+)\/transcript\/(transcript-items|session-images)\/([^/]+)(?:\/(\d+))?$/);
    if (!match || match[2] !== adapter.id || request.method !== "GET" || !adapter.loadTranscript) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const agentId = decodeURIComponent(match[3]!);
    await agents.ready(workspaceId, agentId);
    const ctx = context(workspaceId, agentId, adapter.id);
    if (match[4] === "session-images") {
      if (!adapter.loadTranscriptImage || match[6] === undefined) return new Response("Not found", { status: 404 });
      return adapter.loadTranscriptImage(workspaceId, agentId, decodeURIComponent(match[5]!), Number(match[6]));
    }
    const records = await adapter.loadTranscript(workspaceId, agentId);
    const count = Math.max(100, Math.min(100_000, Number(url.searchParams.get("count") ?? 100) || 100));
    const html = records && renderReadOnlyTranscriptDetail(ctx, records, decodeURIComponent(match[5]!), count);
    return response(html ?? "Not found", { status: html ? 200 : 404 });
  };
}
