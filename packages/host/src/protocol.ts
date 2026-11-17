import type { HostMetricId } from "./diagnostics.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
export const hostSocketPath = "/run/agents-in-the-cloud-host/control.sock";
export interface HostMetric { id: HostMetricId; value: string; warning?: boolean }
export interface HostSection { title: string; text: string; error?: boolean }
export interface HostSample { sampledAt: string; durationMs: number; metrics: HostMetric[]; sections: HostSection[] }
export interface HostResults {
  sample: HostSample;
  "private-network-access": null;
}
export type HostResult = HostResults[keyof HostResults];
const privateNetworkFirewallEntry = Type.Object({ bridge: Type.String(), address: Type.String(), port: Type.Integer() }, { additionalProperties: false });
export type PrivateNetworkFirewallEntry = Static<typeof privateNetworkFirewallEntry>;
const requestSchema = Type.Union([
  Type.Object({ operation: Type.Literal("sample"), fresh: Type.Optional(Type.Boolean()) }),
  Type.Object({ operation: Type.Literal("private-network-access"), destinations: Type.Array(privateNetworkFirewallEntry, { maxItems: 100_000 }) }),
]);
export type HostCommand = Static<typeof requestSchema>;
export function parseHostRequest(line: string): HostCommand { return Value.Parse(requestSchema, JSON.parse(line)); }
export type HostReply = { type: "result"; value: HostResult } | { type: "error"; message: string };
