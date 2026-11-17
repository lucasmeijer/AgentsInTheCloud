import { Type } from "typebox";
import { Value } from "typebox/value";
import { isNotFoundError } from "@agents-in-the-cloud/core";
import { isWorkspaceAppPort } from "@agents-in-the-cloud/shared";
import { mkdir, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceIngress } from "./index.ts";

const publicationSchema = Type.Object({
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("https")])),
}, { additionalProperties: false });

export function createWorkspaceIngressSockets(ingress: WorkspaceIngress, directory: string, handleRequest?: (request: Request, workspaceId: string) => Promise<Response | undefined> | Response | undefined) {
  const servers = new Map<string, ReturnType<typeof Bun.serve>>();
  const pending = new Map<string, Promise<void>>();
  return {
    async ensure(workspaceId: string): Promise<void> {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(workspaceId)) throw new Error("Invalid workspace id");
      if (servers.has(workspaceId)) return;
      if (pending.has(workspaceId)) return pending.get(workspaceId);
      const creating = (async () => {
        const path = join(directory, workspaceId, "ingress.sock");
        await mkdir(join(directory, workspaceId), { recursive: true });
        try { await unlink(path); } catch (error) { if (!isNotFoundError(error)) throw error; }
        const server = Bun.serve({ unix: path, maxRequestBodySize: 4 * 1024 * 1024, async fetch(request, server) {
          server.timeout(request, 0);
          const handled = await handleRequest?.(request, workspaceId);
          if (handled) return handled;
          if (new URL(request.url).pathname === "/health" && request.method === "GET") return new Response("ok");
          if (new URL(request.url).pathname !== "/origins" || request.method !== "POST") return new Response("Not found", { status: 404 });
          let input: unknown;
          try { input = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
          if (!Value.Check(publicationSchema, input) || !isWorkspaceAppPort(input.port)) return new Response("Expected {port: 1..65535, protocol: http|https}", { status: 400 });
          const origin = await ingress.publishPort(workspaceId, input.port, input.protocol);
          return Response.json({ origin });
        } });
        await chmod(path, 0o666);
        servers.set(workspaceId, server);
      })().finally(() => pending.delete(workspaceId));
      pending.set(workspaceId, creating);
      return creating;
    },
    async remove(workspaceId: string) { servers.get(workspaceId)?.stop(true); servers.delete(workspaceId); await ingress.stopWorkspace(workspaceId); },
    stop() { for (const server of servers.values()) server.stop(true); servers.clear(); },
  };
}
