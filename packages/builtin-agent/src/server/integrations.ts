import type { Models } from "@earendil-works/pi-ai";
import type { ConversationView, Extension, Harness } from "@earendil-works/pi-durable";
import type { BackgroundActivity } from "@agents-in-the-cloud/agent/server/background-activity";
import type { AgentTranscriptSnapshot } from "@agents-in-the-cloud/agent/server/transcript-contributions";

export interface BackgroundActivitySource {
  activities(workspaceId: string, rootId: string): Promise<BackgroundActivity[]>;
  watch?(harness: Harness, changed: () => void): Promise<() => Promise<void>>;
  detail(workspaceId: string, rootId: string, activity: BackgroundActivity): Promise<string>;
  stop(workspaceId: string, activity: BackgroundActivity): Promise<void>;
}

/**
 * A feature that extends every workspace's Builtin Agents: tools in their registry, what it adds to their
 * transcripts, and the work it lists in their Background bars. Registered when its module initializes, before any
 * workspace owner opens.
 */
export interface BuiltinAgentIntegration {
  id: string;
  extension?(workspaceId: string, models: Models): Extension;
  transcript?(view: ConversationView): Partial<AgentTranscriptSnapshot>;
  background?: BackgroundActivitySource;
}

const integrations: BuiltinAgentIntegration[] = [];

export function registerBuiltinAgentIntegration(integration: BuiltinAgentIntegration): () => void {
  if (integrations.some(item => item.id === integration.id)) throw new Error(`Builtin Agent integration already registered: ${integration.id}`);
  integrations.push(integration);
  return () => { integrations.splice(integrations.indexOf(integration), 1); };
}

export function builtinAgentIntegrations(): readonly BuiltinAgentIntegration[] {
  return integrations;
}

export function integrationTranscript(view: ConversationView): AgentTranscriptSnapshot | undefined {
  const parts = integrations.flatMap(integration => integration.transcript ? [integration.transcript(view)] : []);
  if (!parts.length) return undefined;
  return {
    messages: parts.flatMap(part => part.messages ?? []),
    anchors: parts.flatMap(part => part.anchors ?? []),
    nested: parts.flatMap(part => part.nested ?? []),
    scriptFiles: parts.flatMap(part => part.scriptFiles ?? []),
    inheritedContext: parts.find(part => part.inheritedContext)?.inheritedContext,
  };
}
