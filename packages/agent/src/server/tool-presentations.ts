import type { AgentRenderContext } from "./render-context.ts";
import type { ToolView } from "./transcript.ts";

export interface AgentToolPresentation {
  summary(tool: ToolView): string | undefined;
  detail(ctx: AgentRenderContext, tool: ToolView): string | undefined;
}

const registered: Array<ReadonlyMap<string, AgentToolPresentation>> = [];

export function registerAgentToolPresentations(presentations: ReadonlyMap<string, AgentToolPresentation>): () => void {
  for (const name of presentations.keys()) if (agentToolPresentation(name)) throw new Error(`Tool presentation already registered: ${name}`);
  registered.push(presentations);
  return () => { registered.splice(registered.indexOf(presentations), 1); };
}

export function agentToolPresentation(name: string): AgentToolPresentation | undefined {
  for (const presentations of registered) {
    const presentation = presentations.get(name);
    if (presentation) return presentation;
  }
  return undefined;
}
