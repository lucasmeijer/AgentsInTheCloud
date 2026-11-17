import { cp, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createKeyedOperationQueue, readTextIfExists, requireDocker, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceDockerContainerFile } from "./types.ts";

export const workspaceConfigurationLabel = "com.agents-in-the-cloud.configuration-checkpoint";

const serialize = createKeyedOperationQueue();

const checkpointSchema = Type.Object({
  phase: Type.Union([Type.Literal("configuring"), Type.Literal("configured"), Type.Literal("running")]),
  files: Type.Array(Type.Object({ source: Type.String({ minLength: 1 }), target: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
}, { additionalProperties: false });

/** Configuration is committed before the first start. Recovery replays only file
 * copies, never plan preparation or repository hooks. Runtime preparation runs
 * after every start, independently of the configuration checkpoint. */
export function createWorkspaceContainerLifecycle(options: {
  directory: string;
  container: string;
  checkpointRequired: boolean;
  started(): Promise<void>;
  waitForStartup(): Promise<string>;
  docker?: typeof requireDocker;
}) {
  const docker = options.docker ?? requireDocker;
  const checkpointPath = join(options.directory, "checkpoint.json");
  return {
    snapshot(files: WorkspaceDockerContainerFile[]): Promise<void> {
      return serialize(options.directory, async () => {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        const saved: WorkspaceDockerContainerFile[] = [];
        for (const [index, file] of files.entries()) {
          const directory = join(options.directory, "files", String(index));
          const source = join(directory, basename(file.source));
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await cp(file.source, source, { recursive: true, dereference: true, preserveTimestamps: true });
          saved.push({ source, target: file.target });
        }
        await writeJsonAtomic(checkpointPath, { phase: "configuring", files: saved }, { mode: 0o600 });
      });
    },
    ensureStarted(): Promise<string> {
      return serialize(options.directory, async () => {
        const text = await readTextIfExists(checkpointPath);
        if (text === undefined) {
          if (options.checkpointRequired) throw new Error(`Missing configuration checkpoint for ${options.container}`);
          await docker(["start", options.container]);
          await options.started();
          return "";
        }
        const checkpoint = Value.Parse(checkpointSchema, JSON.parse(text));
        if (checkpoint.phase === "configuring") {
          for (const file of checkpoint.files) await docker(["cp", file.source, `${options.container}:${file.target}`]);
          checkpoint.phase = "configured";
          await writeJsonAtomic(checkpointPath, checkpoint, { mode: 0o600 });
        }
        await docker(["start", options.container]);
        await options.started();
        return options.waitForStartup();
      });
    },
  };
}
