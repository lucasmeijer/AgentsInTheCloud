import type { AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import type { DeleteCurrentWorkspaceResult, WorkspaceWorkViewReference } from "@agents-in-the-cloud/shared";
import { Type, type TSchema } from "typebox";
import { defineWorkspaceTool, type WorkspaceTool } from "./workspace-tool.ts";

export interface WorkspaceAgentToolOptions {
  events?: AgentsInTheCloudEventBus;
  embeds?: boolean;
}

export interface WorkspacePresenterDeps {
  events?: AgentsInTheCloudEventBus;
  presentWorkView(reference: WorkspaceWorkViewReference): Promise<void>;
}

type WorkspaceAgentToolFactory = (workspaceId: string, options: WorkspaceAgentToolOptions) => WorkspaceTool<any, any>;

export interface WorkspacePresenterDefinition<Params extends { kind: string } = { kind: string }> {
  kind: Params["kind"];
  description: string;
  parameters: Record<string, TSchema>;
  execute(toolCallId: string, params: Params): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

type WorkspacePresenterFactory = (workspaceId: string, options: WorkspaceAgentToolOptions) => WorkspacePresenterDefinition<any>;

const registeredWorkspaceAgentTools = new Map<string, WorkspaceAgentToolFactory>();
const registeredWorkspacePresenters = new Map<string, WorkspacePresenterFactory>();

export function registerWorkspaceAgentTool(name: string, factory: WorkspaceAgentToolFactory): () => void {
  registeredWorkspaceAgentTools.set(name, factory);
  return () => {
    if (registeredWorkspaceAgentTools.get(name) === factory) registeredWorkspaceAgentTools.delete(name);
  };
}

export function registerWorkspacePresenter(kind: string, factory: WorkspacePresenterFactory): () => void {
  registeredWorkspacePresenters.set(kind, factory);
  return () => {
    if (registeredWorkspacePresenters.get(kind) === factory) registeredWorkspacePresenters.delete(kind);
  };
}

const presentEmbedHint = " Images, videos, SVGs, and HTML files are already automatically visible to the user when you reference them with an AgentsInTheCloud embed URL in Markdown image syntax, for example: ![](artifact-preview:/work/app/screenshot.png) or ![](artifact-preview:/work/app/demo.html).";

function createPresentTool(workspaceId: string, options: WorkspaceAgentToolOptions): WorkspaceTool<any, any> | undefined {
  const presenters = [...registeredWorkspacePresenters.values()].map((factory) => factory(workspaceId, options));
  if (!presenters.length) return undefined;
  const kinds = presenters.map((presenter) => presenter.kind);
  const presenterParameters = Object.fromEntries(presenters.flatMap((presenter) =>
    Object.entries(presenter.parameters).map(([name, schema]) => [name, Type.Optional(schema)]),
  ));
  return defineWorkspaceTool({
    name: "present",
    label: "Present",
    description: "Present one primary interactive surface to the user in AgentsInTheCloud. Use this when the user should look at or interact with while evaluating your work. AgentsInTheCloud will place the chosen surface in the preview area. Calling this again should update or replace the primary presentation rather than adding multiple competing presentations. Do not use this tool for static or inline artifacts." + (options.embeds ? presentEmbedHint : "") + presenters.map((presenter) => `${presenter.kind}: ${presenter.description}`).join(" "),
    parameters: Type.Object({
      kind: Type.String({ enum: kinds, description: `Surface to present. One of: ${kinds.join(", ")}.` }),
      ...presenterParameters,
    }),
    execute: async (toolCallId: string, params: { kind: string }) => {
      const presenter = presenters.find((candidate) => candidate.kind === params.kind);
      if (!presenter) throw new Error(`unknown presentation kind: ${params.kind}`);
      return await presenter.execute(toolCallId, params);
    },
  });
}

export async function executeDeleteCurrentWorkspace(
  workspaceId: string,
  deleteCurrentWorkspace: (force: boolean) => Promise<DeleteCurrentWorkspaceResult>,
  force: boolean,
) {
  const result = await deleteCurrentWorkspace(force);
  if (result.blocked) {
    return {
      content: [{ type: "text" as const, text: "Current workspace was not deleted because the delete safety checks found outstanding local changes." }],
      details: { workspaceId, ...result },
    };
  }
  return {
    content: [{ type: "text" as const, text: `Current workspace ${workspaceId} deletion has been scheduled. The agent execution context is now being torn down.` }],
    details: { workspaceId, ...result },
  };
}

export function createDeleteCurrentWorkspaceTool(workspaceId: string, deleteCurrentWorkspace: (force: boolean) => Promise<DeleteCurrentWorkspaceResult>): WorkspaceTool<any, any> {
  return defineWorkspaceTool({
    name: "delete_current_workspace",
    label: "Delete Current Workspace",
    description: "Permanently delete this agent's current AgentsInTheCloud workspace. This tears down the execution context the agent has been doing all of its work in, including the workspace container and local files/changes that have not been preserved elsewhere. The agent cannot choose another workspace; this tool always deletes only its own current workspace. Execute this only when the user has explicitly requested deletion of this workspace.",
    parameters: Type.Object({
      force: Type.Boolean({
        description: "Set to false to run the existing workspace delete safety checks and report outstanding local changes instead of deleting when they are present. Set to true only when the user explicitly requested force deletion.",
      }),
    }),
    execute: (_toolCallId: string, params: { force: boolean }) => executeDeleteCurrentWorkspace(workspaceId, deleteCurrentWorkspace, params.force),
  });
}

export function createAgentsInTheCloudControlTools(workspaceId: string, options: WorkspaceAgentToolOptions = {}): WorkspaceTool<any, any>[] {
  const present = createPresentTool(workspaceId, options);
  const external = [...registeredWorkspaceAgentTools.values()].map((factory) => factory(workspaceId, options));
  return [...(present ? [present] : []), ...external];
}
