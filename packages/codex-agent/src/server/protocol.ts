import type { JsonValue } from "@agents-in-the-cloud/core";
import type * as Protocol from "../protocol.ts";

export const codexVersion = "0.160.1";
export interface Requests {
  initialize: [Protocol.InitializeParams, Protocol.InitializeResponse];
  "thread/settings/update": [Protocol.ThreadSettingsUpdateParams, Protocol.ThreadSettingsUpdateResponse];
  "thread/compact/start": [Protocol.ThreadCompactStartParams, Protocol.ThreadCompactStartResponse];
  "review/start": [Protocol.ReviewStartParams, Protocol.ReviewStartResponse];
  "thread/fork": [Protocol.ThreadForkParams, Protocol.ThreadForkResponse];
  "thread/list": [Protocol.ThreadListParams, Protocol.ThreadListResponse];
  "thread/goal/get": [Protocol.ThreadGoalGetParams, Protocol.ThreadGoalGetResponse];
  "thread/goal/set": [Protocol.ThreadGoalSetParams, Protocol.ThreadGoalSetResponse];
  "thread/goal/clear": [Protocol.ThreadGoalClearParams, Protocol.ThreadGoalClearResponse];
  "skills/list": [Protocol.SkillsListParams, Protocol.SkillsListResponse];
  "mcpServerStatus/list": [Protocol.ListMcpServerStatusParams, Protocol.ListMcpServerStatusResponse];
  "hooks/list": [Protocol.HooksListParams, Protocol.HooksListResponse];
  "plugin/install": [Protocol.PluginInstallParams, Protocol.PluginInstallResponse];
  "plugin/uninstall": [Protocol.PluginUninstallParams, Protocol.PluginUninstallResponse];
  "skills/config/write": [Protocol.SkillsConfigWriteParams, Protocol.SkillsConfigWriteResponse];
  "config/value/write": [Protocol.ConfigValueWriteParams, Protocol.ConfigWriteResponse];
  "plugin/list": [Protocol.PluginListParams, Protocol.PluginListResponse];
  "app/list": [Protocol.AppsListParams, Protocol.AppsListResponse];
  "model/list": [Protocol.ModelListParams, Protocol.ModelListResponse];
  "thread/start": [Protocol.ThreadStartParams, Protocol.ThreadStartResponse];
  "thread/resume": [Protocol.ThreadResumeParams, Protocol.ThreadResumeResponse];
  "thread/read": [Protocol.ThreadReadParams, Protocol.ThreadReadResponse];
  "turn/start": [Protocol.TurnStartParams, Protocol.TurnStartResponse];
  "turn/steer": [Protocol.TurnSteerParams, Protocol.TurnSteerResponse];
  "turn/interrupt": [Protocol.TurnInterruptParams, Protocol.TurnInterruptResponse];
}

interface Notifications {
  "turn/started": Protocol.TurnStartedNotification;
  "turn/completed": Protocol.TurnCompletedNotification;
  "item/started": Protocol.ItemStartedNotification;
  "item/completed": Protocol.ItemCompletedNotification;
  "item/agentMessage/delta": Protocol.AgentMessageDeltaNotification;
  "item/plan/delta": Protocol.PlanDeltaNotification;
  "item/reasoning/summaryTextDelta": Protocol.ReasoningSummaryTextDeltaNotification;
  "item/commandExecution/outputDelta": Protocol.CommandExecutionOutputDeltaNotification;
  "thread/tokenUsage/updated": Protocol.ThreadTokenUsageUpdatedNotification;
  "client/unsupportedRequest": { method: string };
  error: Protocol.ErrorNotification;
}
export type CodexNotification = { [M in keyof Notifications]: { method: M; params: Notifications[M] } }[keyof Notifications];
const notifications = {
  "turn/started": true,
  "turn/completed": true,
  "item/started": true,
  "item/completed": true,
  "item/agentMessage/delta": true,
  "item/plan/delta": true,
  "item/reasoning/summaryTextDelta": true,
  "item/commandExecution/outputDelta": true,
  "thread/tokenUsage/updated": true,
  "client/unsupportedRequest": true,
  error: true,
} satisfies Record<keyof Notifications, true>;

export function codexNotification(method: string, params: JsonValue): CodexNotification | undefined {
  if (!Object.hasOwn(notifications, method)) return undefined;
  // SAFETY: The RPC envelope is parsed at ingress, and the pinned Codex executable
  // owns these payloads. Their shapes match its generated protocol types.
  return { method, params } as CodexNotification;
}
