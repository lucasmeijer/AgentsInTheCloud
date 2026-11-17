import type { JsonValue } from "@agents-in-the-cloud/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { liveRegionDigestsSchema, type LiveRegionDigests } from "./live-presentation.ts";

export interface CableSubscriptionOptions {
  onReady?: () => void;
  onDisconnected?: () => void;
  onRejected?: (reason: string) => void;
  shownIn?: Element;
}

const cableIdentifierSchema = Type.Union([
  Type.Object({ channel: Type.Literal("shell") }),
  Type.Object({ channel: Type.Literal("module"), name: Type.String({ minLength: 1 }), workspaceId: Type.String({ minLength: 1 }), params: Type.Record(Type.String(), Type.String()) }),
  Type.Object({ channel: Type.Literal("agent"), workspaceId: Type.String({ minLength: 1 }), agentId: Type.String({ minLength: 1 }) }),
  Type.Object({ channel: Type.Literal("agent-turn"), workspaceId: Type.String({ minLength: 1 }), agentId: Type.String({ minLength: 1 }), turnId: Type.String({ minLength: 1 }), branchId: Type.String({ minLength: 1 }) }),
]);

const subscriptionIdSchema = Type.String({ minLength: 1 });

const workspaceVisibilitySchema = Type.Object({ workspaceId: Type.Optional(Type.String({ minLength: 1 })), surfaceKeys: Type.Array(Type.String({ minLength: 1 })) });
export type WorkspaceVisibilityReport = Static<typeof workspaceVisibilitySchema>;

const cableClientMessageSchema = Type.Union([
  Type.Object({ command: Type.Literal("visibility"), visibility: workspaceVisibilitySchema }),
  Type.Object({ command: Type.Literal("subscribe"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, shown: Type.Optional(liveRegionDigestsSchema) }),
  Type.Object({ command: Type.Literal("unsubscribe"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema }),
  Type.Object({ command: Type.Literal("pong"), time: Type.Optional(Type.Number()) }),
]);

const cableServerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("welcome"), connectionId: Type.String() }),
  Type.Object({ type: Type.Literal("confirm_subscription"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, html: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("reject_subscription"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, reason: Type.String() }),
  Type.Object({ type: Type.Literal("turbo_stream"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, html: Type.String() }),
  Type.Object({ type: Type.Literal("ping"), time: Type.Number() }),
  Type.Object({ type: Type.Literal("error"), message: Type.String() }),
]);

export type CableIdentifier = Static<typeof cableIdentifierSchema>;
export type CableClientMessage = Static<typeof cableClientMessageSchema>;
export type CableServerMessage = Static<typeof cableServerMessageSchema>;

function parseJson(text: string, invalidJsonMessage: string): JsonValue {
  let encoded: JsonValue;
  try {
    encoded = JSON.parse(text);
  } catch {
    throw new Error(invalidJsonMessage);
  }
  return encoded;
}

export function decodeCableClientMessage(text: string): CableClientMessage {
  const encoded = parseJson(text, "cable message must be valid JSON");
  try {
    return Value.Parse(cableClientMessageSchema, Value.Clean(cableClientMessageSchema, encoded));
  } catch {
    throw new Error("unsupported cable message");
  }
}

export function decodeCableServerMessage(text: string): CableServerMessage {
  const encoded = parseJson(text, "cable server message must be valid JSON");
  try {
    return Value.Parse(cableServerMessageSchema, Value.Clean(cableServerMessageSchema, encoded));
  } catch {
    throw new Error("unsupported cable server message");
  }
}

export interface CableSubscription {
  unsubscribe(): void;
}

export interface AgentsInTheCloudCableClient {
  reportVisibility(visibility: WorkspaceVisibilityReport): void;
  subscribe(identifier: CableIdentifier, options?: CableSubscriptionOptions): CableSubscription;
  ready(): boolean;
  reconnect(): void;
}

function requireNonEmpty(value: string, message: string): string {
  if (!(value.length > 0)) throw new Error(message);
  return value;
}

export const CableTopics = {
  shell(): CableIdentifier { return { channel: "shell" }; },
  module(name: string, workspaceId: string, params: Record<string, string> = {}): CableIdentifier {
    return { channel: "module", name: requireNonEmpty(name, "channel name must not be empty"), workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"), params };
  },
  agentTurn(workspaceId: string, agentId: string, turnId: string, branchId: string): CableIdentifier {
    return {
      channel: "agent-turn",
      workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"),
      agentId: requireNonEmpty(agentId, "agent identifier must not be empty"),
      turnId: requireNonEmpty(turnId, "agent turn identifier must not be empty"),
      branchId: requireNonEmpty(branchId, "agent branch identifier must not be empty"),
    };
  },
  agent(workspaceId: string, agentId: string): CableIdentifier {
    return {
      channel: "agent",
      workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"),
      agentId: requireNonEmpty(agentId, "agent identifier must not be empty"),
    };
  },
};

export function serializeCableIdentifier(identifier: CableIdentifier): string {
  switch (identifier.channel) {
    case "shell": return JSON.stringify(["shell"]);
    case "module": return JSON.stringify(["module", identifier.name, identifier.workspaceId, Object.entries(identifier.params).sort(([a], [b]) => a.localeCompare(b))]);
    case "agent-turn": return JSON.stringify([
      identifier.channel,
      requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty"),
      requireNonEmpty(identifier.agentId, "agent identifier must not be empty"),
      requireNonEmpty(identifier.turnId, "agent turn identifier must not be empty"),
      requireNonEmpty(identifier.branchId, "agent branch identifier must not be empty"),
    ]);
    case "agent": return JSON.stringify([
      identifier.channel,
      requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty"),
      requireNonEmpty(identifier.agentId, "agent identifier must not be empty"),
    ]);
    default: throw new Error("unsupported cable identifier");
  }
}

export interface CableChannelSubscription {
  unsubscribe(): void;
}

/** The adapter validates its parameters and access before publishing its first snapshot.
 * Cable owns confirmation, cancellation races, incremental delivery and error reporting. */
export interface CableChannelAdapter {
  name: string;
  subscribe(identifier: CableIdentifier, listener: (html: string) => void, events: import("@agents-in-the-cloud/core").AgentsInTheCloudEventBus, shown?: LiveRegionDigests): CableChannelSubscription | Promise<CableChannelSubscription>;
}
