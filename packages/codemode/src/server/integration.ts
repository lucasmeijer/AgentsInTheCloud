import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineExtension } from "@earendil-works/pi-durable";
import type { BuiltinAgentIntegration } from "@agents-in-the-cloud/builtin-agent/server";
import { createWorkspaceCodemodeExtension } from "./extension.ts";
import { createOneShotAgentTool } from "./one-shot-agent.ts";
import { workspaceScriptFiles } from "./script-file.ts";
import { codemodeTranscript } from "./transcript.ts";

// Each script runs in its own worker, so one sandbox serves every conversation.
// The VM shares the server process; the limit keeps a runaway script from taking it down.
const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });

export const codemodeIntegration: BuiltinAgentIntegration = {
  id: "codemode",
  extension(workspaceId, models) {
    const extension = createWorkspaceCodemodeExtension(workspaceId, sandbox, workspaceScriptFiles(workspaceId));
    return defineExtension({ ...extension, tools: [...extension.tools ?? [], createOneShotAgentTool(models)] });
  },
  transcript: codemodeTranscript,
};
