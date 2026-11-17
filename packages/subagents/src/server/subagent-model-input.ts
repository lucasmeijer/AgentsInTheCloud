import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject, type JsonObject } from "@agents-in-the-cloud/core";
import type { AgentMessageInput } from "./subagent-protocol.ts";

/** Bridge Pi's standard-message pipeline to Codex's native Responses input item.
 * Per-conversion opaque placeholders prevent user text from masquerading as agent traffic.
 * They are removed before the request leaves AgentsInTheCloud; no IDs enter the textual envelope. */
export class SubagentModelInput {
  private readonly messages = new Map<string, AgentMessageInput>();
  private placeholder(message: AgentMessageInput): string {
    const token = `agents-in-the-cloud-agent-message:${randomUUID()}`;
    this.messages.set(token, message);
    return token;
  }
  forModel(message: AgentMessageInput, api: string, timestamp: number) {
    return { role: "user" as const, content: api === "openai-codex-responses" ? this.placeholder(message) : message.content.map((part) => part.text).join("\n"), timestamp };
  }
  transform(payload: JsonObject, api: string): JsonObject {
    if (!this.messages.size) return payload;
    if (api !== "openai-codex-responses") throw new Error("Native agent-message placeholders reached a non-native provider; select the user-message mapping before provider serialization.");
    if (!Array.isArray(payload.input)) throw new Error("Expected a Codex Responses input array.");
    return { ...payload, input: payload.input.map((item) => {
      if (!isJsonObject(item) || !Array.isArray(item.content)) return item;
      const tokens = item.content.filter(isJsonObject).filter((part) => part.type === "input_text" && Value.Check(Type.String(), part.text) && this.messages.has(part.text));
      if (!tokens.length) return item;
      if (tokens.length !== 1 || item.content.length !== 1) throw new Error("Pi merged an agent-message placeholder with other content.");
      return this.messages.get(String(tokens[0]!.text))!;
    }) };
  }
}
