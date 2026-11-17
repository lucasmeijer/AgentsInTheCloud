import { createNativeAgentStore } from "@agents-in-the-cloud/native-agent/server";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { label } from "./setup.ts";

const schema = Type.Object({ agents: Type.Array(Type.Object({
  id: Type.String(), title: Type.String(), sessionId: Type.String(),
  forkedFrom: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()),
  submissions: Type.Array(Type.Object({ id: Type.String(), digest: Type.String() })),
  commandSubmissions: Type.Optional(Type.Array(Type.Object({ id: Type.String(), digest: Type.String(), message: Type.String() }))),
})) });
export type ClaudeAgentRecord = Static<typeof schema>["agents"][number];
export const createClaudeStore = () => createNativeAgentStore("claude-code-agents.json", label, value => Value.Parse(schema, value).agents);
