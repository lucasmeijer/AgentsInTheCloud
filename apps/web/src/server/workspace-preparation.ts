import { withCommandSignal } from "@agents-in-the-cloud/core";
import { errorMessage } from "@agents-in-the-cloud/shared";
import type { WorkspaceProvisioning, WorkspaceProvisionRun } from "@agents-in-the-cloud/workspace";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

interface WorkspacePreparationOperations {
  prepareRuntime(id: string, report: (detail: string) => void): Promise<void>;
  provisioning: WorkspaceProvisioning;
  runtimePrepared?(id: string): Promise<void>;
}

async function prepare(id: string, registry: WorkspaceRegistry, operations: WorkspacePreparationOperations, run: WorkspaceProvisionRun): Promise<void> {
  const entry = registry.get(id);
  const current = () => registry.get(id) === entry && !entry?.phase.deletion;
  await run.step("workspace.preparation", "Prepare workspace", async () => {
    if (!current()) return;
    try {
      await operations.prepareRuntime(id, (detail) => run.report({ detail }));
      if (current()) registry.setWarning(id, "preparation");
    } catch (error) {
      if (!current()) return;
      const message = `${errorMessage(error)} Required images or gateways may be unavailable.`;
      console.error(`workspace preparation failed ${id}`, error);
      registry.setWarning(id, "preparation", message);
      throw error;
    }
  }, "retry-or-continue");
  if (current()) await operations.runtimePrepared?.(id);
}

export function prepareWorkspaceForUse(id: string, registry: WorkspaceRegistry, operations: WorkspacePreparationOperations): Promise<void> {
  return operations.provisioning.run(id, (run) => prepare(id, registry, operations, run));
}

interface ReprovisionOperations extends WorkspacePreparationOperations {
  ensureStarted(id: string): Promise<string | void>;
  stop(id: string): Promise<null | void>;
  imageOutdated(id: string): Promise<boolean>;
}

export async function reprovisionWorkspaces(
  registry: WorkspaceRegistry,
  operations: ReprovisionOperations,
): Promise<void> {
  await Promise.all(registry.list().flatMap((entry) => {
    if (entry.phase.deletion) return [];
    const { id, parked } = entry;
    const current = () => registry.get(id) === entry && !entry.phase.deletion && entry.parked === parked;
    registry.startProvisioning(id);
    const restore = async () => {
      try {
        await operations.provisioning.run(id, async (run) => {
          await run.step("workspace.container", parked ? "Keep workspace parked" : "Start workspace container", () => parked ? operations.stop(id) : operations.ensureStarted(id));
          if (!current() || parked) return;
          await prepare(id, registry, operations, run);
        });
        if (current()) registry.startRunning(id);
      } catch (error) {
        if (!current()) return;
        console.error(`could not restore workspace ${id}`, error);
        registry.setProvisioningState(id, "failed", errorMessage(error));
      }
    };
    const inspectImage = async () => {
      try {
        const outdated = await withCommandSignal(AbortSignal.timeout(60_000), () => operations.imageOutdated(id));
        if (current()) {
          registry.setImageOutdated(id, outdated);
          registry.setWarning(id, "image");
        }
      } catch (error) {
        console.error(`could not inspect workspace image ${id}`, error);
        if (current()) registry.setWarning(id, "image", "Could not check whether this workspace image is up to date.");
      }
    };
    return [restore(), inspectImage()];
  }));
}
