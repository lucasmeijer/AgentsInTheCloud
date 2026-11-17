import { AgentsInTheCloudCoreError, invalidArguments, withCommandSignal, type AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { errorMessage, type WorkspaceProvisionFailurePolicy } from "@agents-in-the-cloud/shared";

export interface WorkspaceProvisionProgress {
  detail?: string;
  output?: string;
  terminalSocketPath?: string;
}
export type WorkspaceProvisionStepStatus = "running" | "done" | "failed" | "warning";
export interface WorkspaceProvisionStep extends WorkspaceProvisionProgress {
  id: string;
  label: string;
  status: WorkspaceProvisionStepStatus;
  error?: string;
  durationMs?: number;
}
export interface WorkspaceProvisionSnapshot {
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  steps: WorkspaceProvisionStep[];
  waiting?: { stepId: string; retryable: boolean; continuable: boolean };
  totalMs?: number;
  error?: string;
}

declare module "@agents-in-the-cloud/core" {
  interface AgentsInTheCloudEventMap {
    workspace_provision_progress: WorkspaceProvisionProgress & { workspaceId: string };
  }
}

export interface WorkspaceProvisionRun {
  readonly signal: AbortSignal;
  step<T>(id: string, label: string, work: () => Promise<T> | T): Promise<T>;
  step(id: string, label: string, work: () => Promise<void> | void, failurePolicy: WorkspaceProvisionFailurePolicy | undefined): Promise<void>;
  report(progress: WorkspaceProvisionProgress): void;
}

export interface WorkspaceProvisioning {
  run<T>(workspaceId: string, work: (run: WorkspaceProvisionRun) => Promise<T>): Promise<T>;
  snapshot(workspaceId: string): WorkspaceProvisionSnapshot | undefined;
  resume(workspaceId: string, action: "retry" | "continue"): string;
  delete(workspaceId: string): void;
  cancel(workspaceId: string): Promise<void>;
  drain(): Promise<void>;
}

interface ProvisioningState {
  controller: AbortController;
  settled: ReturnType<typeof Promise.withResolvers<void>>;
  idle: ReturnType<typeof Promise.withResolvers<void>>;
  status: "running" | "done" | "failed" | "cancelled";
  steps: WorkspaceProvisionStep[];
  startedAt: number;
  totalMs?: number;
  error?: string;
  pending?: { stepId: string; retryable: boolean; continuable: boolean; resolve(action: "retry" | "continue"): void };
}

export function createWorkspaceProvisioning(options: { events?: AgentsInTheCloudEventBus; onChange?: (workspaceId: string) => void; stepTimeoutMs?: number } = {}): WorkspaceProvisioning {
  const runs = new Map<string, ProvisioningState>();
  const executing = new Set<ProvisioningState>();
  let stopping = false;
  function cancel(id: string): Promise<void> {
    const run = runs.get(id);
    if (!run) return Promise.resolve();
    if (run.status === "running") {
      run.status = "cancelled";
      run.totalMs = Math.round(performance.now() - run.startedAt);
      for (const step of run.steps) {
        if (step.status === "running") { step.status = "failed"; step.error = "Preparation cancelled"; }
      }
      run.controller.abort(new Error(`workspace ${id} provisioning cancelled`));
      run.pending?.resolve("continue");
      run.pending = undefined;
    }
    return run.settled.promise;
  }
  return {
    cancel,
    async drain() {
      stopping = true;
      await Promise.all([...executing].filter((run) => !run.pending).map(async (run) => {
        if (run.status !== "cancelled") await run.idle.promise;
        if (run.status === "cancelled") await run.settled.promise;
      }));
    },
    snapshot(id) {
      const run = runs.get(id);
      if (!run) return undefined;
      const { pending, startedAt, controller: _controller, settled: _settled, idle: _idle, ...state } = run;
      return structuredClone({ ...state, totalMs: state.totalMs ?? Math.round(performance.now() - startedAt), status: pending ? "waiting" : state.status, waiting: pending && { stepId: pending.stepId, retryable: pending.retryable, continuable: pending.continuable } });
    },
    resume(id, action) {
      if (stopping) throw new Error("Workspace preparation is shutting down");
      const run = runs.get(id);
      if (!run?.pending) throw new AgentsInTheCloudCoreError("workspace_not_ready", `workspace ${id} is not waiting for provisioning confirmation`);
      const pending = run.pending;
      if (action === "continue" && !pending.continuable) throw invalidArguments("This step must succeed before continuing");
      if (action === "retry" && !pending.retryable) throw invalidArguments("This step does not support retry");
      run.pending = undefined;
      run.idle = Promise.withResolvers<void>();
      pending.resolve(action);
      options.onChange?.(id);
      return pending.stepId;
    },
    delete(id) {
      void cancel(id);
      runs.delete(id);
    },
    async run<T>(workspaceId: string, work: (run: WorkspaceProvisionRun) => Promise<T>): Promise<T> {
      if (stopping) throw new Error("Workspace preparation is shutting down");
      if (runs.get(workspaceId)?.status === "running") throw new Error(`workspace ${workspaceId} already has an active provisioning run`);
      const state: ProvisioningState = { controller: new AbortController(), settled: Promise.withResolvers<void>(), idle: Promise.withResolvers<void>(), status: "running", steps: [], startedAt: performance.now() };
      runs.set(workspaceId, state);
      executing.add(state);
      let active: WorkspaceProvisionStep | undefined;
      const changed = () => options.onChange?.(workspaceId);
      const checkCancelled = () => state.controller.signal.throwIfAborted();
      const run: WorkspaceProvisionRun = {
        signal: state.controller.signal,
        report(progress) {
          checkCancelled();
          if (!active || active.status !== "running") throw new Error("Provisioning progress requires a running step");
          Object.assign(active, progress);
          changed();
        },
        async step<T>(id: string, label: string, operation: () => Promise<T> | T, failurePolicy?: WorkspaceProvisionFailurePolicy): Promise<T> {
          checkCancelled();
          if (active) throw new Error("Provisioning steps must execute sequentially");
          if (state.steps.some((step) => step.id === id)) throw new Error(`Duplicate provisioning step: ${id}`);
          const index = state.steps.length;
          try {
            while (true) {
              checkCancelled();
              const step: WorkspaceProvisionStep = { id, label, status: "running" };
              const startedAt = performance.now();
              state.steps[index] = active = step;
              changed();
              try {
                const deadline = new AbortController();
                const timer = setTimeout(() => deadline.abort(new Error(`${label}${step.detail ? `: ${step.detail}` : ""} timed out. Retry preparation or delete this workspace.`)), options.stepTimeoutMs ?? 10 * 60_000);
                let result: T;
                try {
                  result = await withCommandSignal(AbortSignal.any([state.controller.signal, deadline.signal]), operation);
                  deadline.signal.throwIfAborted();
                } finally { clearTimeout(timer); }
                checkCancelled();
                step.durationMs = Math.round(performance.now() - startedAt);
                step.status = "done";
                changed();
                return result;
              } catch (error) {
                checkCancelled();
                step.durationMs = Math.round(performance.now() - startedAt);
                step.status = "failed";
                step.error = errorMessage(error);
                if (!failurePolicy) {
                  changed();
                  throw error;
                }
                const pending = Promise.withResolvers<"retry" | "continue">();
                state.pending = { stepId: id, retryable: failurePolicy !== "continue", continuable: failurePolicy !== "retry", resolve: pending.resolve };
                state.idle.resolve();
                changed();
                const action = await pending.promise;
                checkCancelled();
                if (action === "retry") continue;
                step.status = "warning";
                changed();
                // SAFETY: The failure-policy overload returns void; only that overload can reach continuation.
                return undefined as T;
              }
            }
          } finally { active = undefined; }
        },
      };
      const unsubscribe = options.events?.on("workspace_provision_progress", ({ workspaceId: id, ...progress }) => {
        if (id === workspaceId) run.report(progress);
      });
      try {
        changed();
        const result = await work(run);
        checkCancelled();
        state.totalMs = Math.round(performance.now() - state.startedAt);
        state.status = "done";
        changed();
        return result;
      } catch (error) {
        if (state.status !== "cancelled") {
          state.totalMs = Math.round(performance.now() - state.startedAt);
          state.status = "failed";
          state.error = errorMessage(error);
          changed();
        }
        throw error;
      } finally { unsubscribe?.(); executing.delete(state); state.settled.resolve(); state.idle.resolve(); }
    },
  };
}
