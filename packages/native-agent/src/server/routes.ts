import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments, readJsonObject, requestAcceptsJson, type JsonValue } from "@agents-in-the-cloud/core";
import { expandSlashCommand } from "@agents-in-the-cloud/agent/server/slash-command-input";
import { listFileCompletions, renderFileCompletionMenu } from "@agents-in-the-cloud/agent/server/file-completions";
import { runAgentNameCommand } from "@agents-in-the-cloud/agent/server/agent-name-command";
import { agentAttachmentDraftId, deliverAttachmentDraft, removeStagedAttachments } from "@agents-in-the-cloud/prompt/server";
import { findTranscriptItem, isTranscriptTarget } from "@agents-in-the-cloud/agent/server/transcript";
import { renderModelContextDetailFrame, renderTranscriptItemDetailFrame } from "@agents-in-the-cloud/agent/server/render-transcript";
import { renderBackgroundGone, renderBackgroundInlineDetail, renderBackgroundPage } from "@agents-in-the-cloud/agent/server/background-activity";
import { ids } from "@agents-in-the-cloud/agent/server/render-context";
import { response, textResponse } from "@agents-in-the-cloud/shared/http";
import { turboStream, workspaceModuleModalFrameId, turboStreamResponse } from "@agents-in-the-cloud/shared";
import type { NativeAgentRuntime, NativeAgents } from "./agents.ts";
import type { NativeAgentRendering } from "./render.ts";

export type NativeAgentField = (key: string) => JsonValue | FormDataEntryValue | undefined;
type CommandResult = { kind: string };

export function createNativeAgentRoutes<Runtime extends NativeAgentRuntime, Command, Result extends CommandResult>(agents: NativeAgents<Runtime>, rendering: NativeAgentRendering<Runtime>, options: {
  unknownCommand: string;
  parseCommand(text: string): Command | undefined;
  runCommand(runtime: Runtime, command: Command, request: { requestId: string; field: NativeAgentField }): Promise<Result>;
  renderCommandDialog(runtime: Runtime, result: Result): string;
  promptText(runtime: Runtime): string;
  delivered(runtime: Runtime, requestId: string): boolean;
  isHarnessCommand?(runtime: Runtime, text: string): boolean;
  newConversation?(runtime: Runtime): Promise<void>;
  sessionImage(runtime: Runtime, entryId: string, index: number): Response;
}) {
  const verbatim = (runtime: Runtime, text: string) => options.parseCommand(text) !== undefined || options.isHarnessCommand?.(runtime, text) === true;
  return async (request: Request, url: URL): Promise<Response | undefined> => {
    const match = url.pathname.match(new RegExp(`^/workspaces/([^/]+)/${rendering.routeSegment}/([^/]+)/(.+)$`));
    if (!match) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const agentId = decodeURIComponent(match[2]!);
    const operation = match[3]!;
    const runtime = await agents.ready(workspaceId, agentId);
    const json = request.method === "POST" && requestAcceptsJson(request) ? await readJsonObject(request) : undefined;
    const form = request.method === "POST" && !json ? await request.formData() : undefined;
    const field: NativeAgentField = key => json?.[key] ?? form?.get(key) ?? undefined;
    const requestId = () => {
      const value = field("requestId") ?? crypto.randomUUID();
      if (!Value.Check(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" }), value)) throw invalidArguments("Invalid request ID");
      return value;
    };
    const state = () => ({ agentId, state: runtime.isBusy ? "running" : "idle" });
    const success = (accepted = false, headers: Record<string, string> = {}) => json
      ? Response.json({ agent: state() }, { status: accepted ? 202 : 200, headers })
      : turboStreamResponse("", { headers });
    if ((operation === "messages" || operation === "commands") && request.method === "POST") {
      const command = options.parseCommand([String(field("text") ?? ""), String(field("argument") ?? "").trim()].filter(Boolean).join(" "));
      if (command !== undefined) {
        const result = await options.runCommand(runtime, command, { requestId: requestId(), field });
        return json ? Response.json({ agent: state(), command: result }, { status: result.kind === "done" ? 202 : 200 })
          : turboStreamResponse(turboStream("update", workspaceModuleModalFrameId, result.kind === "done" ? "" : options.renderCommandDialog(runtime, result)));
      }
      if (operation === "commands") throw invalidArguments(options.unknownCommand);
    }
    if (operation === "messages" && request.method === "POST") {
      const text = String(field("text") ?? "");
      if (text.trim() === "/new" && options.newConversation) { await options.newConversation(runtime); return success(); }
      if (text.trim() === "/park") return new Response(null, { status: 307, headers: { Location: `/workspaces/${encodeURIComponent(workspaceId)}/park` } });
      const named = await runAgentNameCommand(text, {
        suggest: () => agents.suggestTitle(runtime, options.promptText(runtime)),
        setTitle: title => agents.rename(runtime, title),
      });
      if (named) { if (named === "no-title") throw invalidArguments("Send a prompt before asking for an Agent name"); return success(); }
      const id = requestId();
      const draft = agentAttachmentDraftId(workspaceId, agentId);
      if (form && field("attachmentDraft") !== draft) throw invalidArguments("Invalid attachment draft");
      const consumedHeaders = { "x-agents-in-the-cloud-attachment-draft-consumed": "true" };
      if (form && options.delivered(runtime, id)) return success(true, consumedHeaders);
      const attachmentIds = form?.getAll("attachment").map(String) ?? [];
      const attachments = await deliverAttachmentDraft(workspaceId, draft, attachmentIds);
      const harnessCommand = options.isHarnessCommand?.(runtime, text) === true;
      const expanded = harnessCommand ? text.trim() : await expandSlashCommand(workspaceId, text);
      if (!expanded.trim() && !attachments.images.length && !attachments.attachmentNotes.length) throw invalidArguments("Write a prompt or attach a file");
      const prompts = harnessCommand ? "" : [options.promptText(runtime), expanded].filter(Boolean).join("\n\n");
      await runtime.send({ text: expanded, ...attachments }, id);
      void agents.nameFromPrompts(runtime, prompts).catch(error => console.error(`Could not name ${agentId}`, error));
      await removeStagedAttachments(draft, attachmentIds);
      return success(true, consumedHeaders);
    }
    if (operation === "abort" && request.method === "POST") { await runtime.stop(); return success(); }
    if (operation === "model" && request.method === "POST") { await runtime.configure({ model: String(field("model") ?? "") }); return success(); }
    if (operation === "thinking-level" && request.method === "POST") { await runtime.configure({ thinkingLevel: String(field("thinkingLevel") ?? "") }); return success(); }
    if (operation === "completions" && request.method === "GET") return response(renderFileCompletionMenu(await listFileCompletions(workspaceId, url.searchParams.get("q") ?? "", url.searchParams.get("mode") === "fuzzy" ? "fuzzy" : "direct")));
    if (operation === "completions/slash-command-expand" && request.method === "POST") {
      const text = String(field("text") ?? "");
      return textResponse(verbatim(runtime, text) ? text.trim() : await expandSlashCommand(workspaceId, text));
    }
    const background = operation.match(/^background\/([^/]+)(?:\/(.+))?$/);
    if (background && rendering.background) {
      const key = decodeURIComponent(background[1]!);
      const path = background[2];
      const ctx = rendering.renderContext(runtime);
      const activity = rendering.background.activities(runtime).find(activity => activity.key === key);
      if (path === "stop" && request.method === "POST" && rendering.background.stop) {
        if (activity?.stoppable) await rendering.background.stop(runtime, activity);
        return success();
      }
      if (path === undefined && request.method === "GET") {
        const page = request.headers.get("turbo-frame") === ids.backgroundPage(ctx);
        if (!activity) return response(renderBackgroundGone(ctx, key, page));
        const detail = await rendering.background.detail(runtime, activity, ctx);
        return response(page ? renderBackgroundPage(ctx, activity, detail) : renderBackgroundInlineDetail(ctx, activity, detail));
      }
      if (path !== undefined && activity) {
        const handled = await rendering.background.route?.(runtime, activity, path, url, ctx);
        if (handled) return handled;
      }
    }
    if (operation.startsWith("transcript-items/") && request.method === "GET") {
      const key = decodeURIComponent(operation.slice("transcript-items/".length));
      const ctx = rendering.renderContext(runtime);
      if (key === "system-prompt") return response(renderModelContextDetailFrame(ctx, { systemPrompt: await runtime.systemPrompt(), tools: [] }, key));
      const item = findTranscriptItem(rendering.transcriptItems(runtime), key);
      if (!item) return new Response("Transcript item not found", { status: 404 });
      const count = Number(url.searchParams.get("count") ?? 100);
      if (!Number.isInteger(count) || count < 1 || count > 10000) throw invalidArguments("Invalid transcript detail size");
      return response(renderTranscriptItemDetailFrame(ctx, item, { count }));
    }
    if (operation.startsWith("reveal/") && request.method === "GET") {
      const key = decodeURIComponent(operation.slice("reveal/".length));
      const section = rendering.transcriptItems(runtime).find(item => item.type === "working" && item.items.some(child => isTranscriptTarget(child, key)));
      return Response.json({ turnId: section?.key ?? null });
    }
    if (operation.startsWith("session-images/") && request.method === "GET") {
      const [, entryId, index] = operation.split("/");
      return options.sessionImage(runtime, decodeURIComponent(entryId!), Number(index));
    }
    return new Response("Not found", { status: 404 });
  };
}
