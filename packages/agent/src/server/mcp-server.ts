import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { errorMessage } from "@agents-in-the-cloud/shared";
import type { WorkspaceTool } from "./workspace-tool.ts";
import { authenticateAgentRequest, type AgentMcpIdentity } from "./mcp-credentials.ts";

interface AgentMcpServerOptions {
  authenticate(token: string): AgentMcpIdentity | undefined;
  tools(identity: AgentMcpIdentity): WorkspaceTool<any, any>[];
  instructions(identity: AgentMcpIdentity): string | Promise<string>;
}

export function createAgentMcpServer(options: AgentMcpServerOptions) {
  const sessions = new Map<string, { identity: AgentMcpIdentity; transport: WebStandardStreamableHTTPServerTransport; server: Server }>();
  return {
    async fetch(request: Request, workspaceId?: string): Promise<Response> {
      const identity = authenticateAgentRequest(request, options.authenticate, workspaceId);
      if (identity instanceof Response) return identity;
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session || (session.identity.workspaceId !== identity.workspaceId || session.identity.agentId !== identity.agentId)) return new Response("Unknown MCP session", { status: 404 });
        return session.transport.handleRequest(request);
      }
      if (request.method !== "POST") return new Response("MCP initialization required", { status: 400 });
      const tools = new Map(options.tools(identity).map((tool) => [tool.name, tool]));
      const server = new Server({ name: "agents-in-the-cloud", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: identity.instructionDelivery === "system-prompt" ? undefined : await options.instructions(identity) });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, { identity, server, transport }); },
        onsessionclosed: (id) => { sessions.delete(id); },
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools.values()].map((tool) => ({ name: tool.name, title: tool.label, description: tool.description, inputSchema: tool.parameters })) }));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const tool = tools.get(request.params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
        const args = request.params.arguments ?? {};
        if (!Value.Check(tool.parameters, args)) throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
        try {
          let progress = 0;
          let updates = Promise.resolve();
          const progressToken = request.params._meta?.progressToken;
          const result = await tool.execute(String(extra.requestId), args, extra.signal, progressToken === undefined ? undefined : (update) => {
            const message = update.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
            const current = ++progress;
            updates = updates.then(() => extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: current, message } }));
          });
          await updates;
          return { content: result.content };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
        }
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      if (!transport.sessionId) await server.close();
      return response;
    },
    async revoke(identity: { workspaceId: string; agentId?: string }): Promise<void> {
      for (const [id, session] of sessions) {
        if (session.identity.workspaceId === identity.workspaceId && (!identity.agentId || session.identity.agentId === identity.agentId)) {
          sessions.delete(id);
          await session.server.close();
        }
      }
    },
  };
}
