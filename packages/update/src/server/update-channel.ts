import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const updateChannelSchema = Type.Union([Type.Literal("stable"), Type.Literal("latest"), Type.Literal("custom")]);

export type UpdateChannel = Static<typeof updateChannelSchema>;

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return Value.Check(updateChannelSchema, value);
}
