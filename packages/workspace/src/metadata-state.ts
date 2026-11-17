import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentsInTheCloudRuntimeContext, isNotFoundError, type JsonValue } from "@agents-in-the-cloud/core";

export interface WorkspaceMetadataState<State extends object> {
  read(workspaceId: string): State;
  write(workspaceId: string, state: State): void;
  delete(workspaceId: string): void;
}

export function createWorkspaceMetadataState<State extends object>(filename: string, parse: (value: JsonValue) => State, initial: () => State, options: { dataDir?: string } = {}): WorkspaceMetadataState<State> {
  const loaded = new Map<string, State>();
  const dataDir = options.dataDir ?? getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir;
  const pathFor = (workspaceId: string) => join(dataDir, "workspaces", workspaceId, "metadata", filename);

  return {
    read(workspaceId) {
      const cached = loaded.get(workspaceId);
      if (cached) return cached;
      const path = pathFor(workspaceId);
      let state: State;
      try {
        state = parse(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        state = initial();
      }
      loaded.set(workspaceId, state);
      return state;
    },
    write(workspaceId, state) {
      const path = pathFor(workspaceId);
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temporary, path);
      loaded.set(workspaceId, state);
    },
    delete(workspaceId) {
      loaded.delete(workspaceId);
      rmSync(pathFor(workspaceId), { force: true });
    },
  };
}
