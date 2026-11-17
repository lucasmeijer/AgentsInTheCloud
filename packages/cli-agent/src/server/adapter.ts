import type { JsonObject } from "@agents-in-the-cloud/core";
import type { CliAgentConnection } from "@agents-in-the-cloud/agent/server";
import type { TranscriptRecord } from "@agents-in-the-cloud/agent/server/transcript";
import type { AgentLaunchFooterContext, AgentWorkspaceParameters, WorkspaceAgentInput } from "@agents-in-the-cloud/shared";

export interface CliAgentSession {
  id: string;
  directory: string;
  turnSignalCommand: string;
}

export interface CliAgentAdapter {
  id: string;
  legacyId?: string;
  label: string;
  iconHtml: string;
  requireSetup(): Promise<void>;
  settings: {
    renderFooter(context: AgentLaunchFooterContext): Promise<string>;
    prepare(parameters?: JsonObject): Promise<AgentWorkspaceParameters>;
  };
  prepareWorkspace?(workspaceId: string): Promise<void>;
  prepareSession(workspaceId: string, session: CliAgentSession, connection: CliAgentConnection): Promise<Record<string, string>>;
  launchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: AgentWorkspaceParameters, session: CliAgentSession): string;
  resumeScript?(workspaceId: string, settings: AgentWorkspaceParameters, session: CliAgentSession): Promise<string>;
  loadTranscript?(workspaceId: string, sessionId: string): Promise<TranscriptRecord[] | undefined>;
  turnSettled?(workspaceId: string, sessionId: string): Promise<boolean>;
  historyFiles?(workspaceId: string, sessionId: string): Promise<string[]>;
  loadTranscriptImage?(workspaceId: string, sessionId: string, entryId: string, contentIndex: number): Promise<Response>;
}
