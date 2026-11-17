import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export type WorkspaceTool<TParams extends TSchema = TSchema, TDetails = unknown> = Pick<
  ToolDefinition<TParams, TDetails>,
  "name" | "label" | "description" | "parameters" | "prepareArguments" | "executionMode"
> & {
  execute(
    callId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: Parameters<ToolDefinition<TParams, TDetails>["execute"]>[3],
  ): ReturnType<ToolDefinition<TParams, TDetails>["execute"]>;
};

export function defineWorkspaceTool<TParams extends TSchema, TDetails = unknown>(tool: WorkspaceTool<TParams, TDetails>): WorkspaceTool<TParams, TDetails> {
  return tool;
}
