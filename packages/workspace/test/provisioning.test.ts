import { describe, expect, test } from "bun:test";
import { createAgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { createWorkspaceProvisioning, workspaceSetupProvisioningHook } from "@agents-in-the-cloud/workspace";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("workspace provisioning execution", () => {
  test("records only executed steps, in execution order, with operation results and output", async () => {
    const events = createAgentsInTheCloudEventBus();
    const provisioning = createWorkspaceProvisioning({ events });
    const pending = Promise.withResolvers<void>();
    const finished = provisioning.run("one", async (run) => {
      const result = await run.step("image", "Use configured image", () => "configured");
      expect(result).toBe("configured");
      await run.step("preload", "Save preload images", async () => {
        await events.emit("workspace_provision_progress", { workspaceId: "one", detail: "Saving", output: "log" });
        await pending.promise;
        run.report({ output: "saved" });
      });
      await run.step("container", "Start container", () => {});
    });
    await tick();
    expect(provisioning.snapshot("one")?.steps).toEqual([
      { id: "image", label: "Use configured image", status: "done", durationMs: expect.any(Number) },
      { id: "preload", label: "Save preload images", status: "running", detail: "Saving", output: "log" },
    ]);
    pending.resolve();
    await finished;
    expect(provisioning.snapshot("one")).toMatchObject({ status: "done", steps: [
      { id: "image", status: "done" }, { id: "preload", status: "done", output: "saved" }, { id: "container", status: "done" },
    ] });
  });

  test("reports actual phase and total timings on success and failure", async () => {
    const provisioning = createWorkspaceProvisioning();
    await provisioning.run("success", async (run) => {
      await run.step("work", "Work", () => new Promise((resolve) => setTimeout(resolve, 15)));
    });
    const success = provisioning.snapshot("success")!;
    expect(success.steps[0]!.durationMs).toBeGreaterThanOrEqual(10);
    expect(success.totalMs!).toBeGreaterThanOrEqual(success.steps[0]!.durationMs!);
    await expect(provisioning.run("failure", async (run) => {
      await run.step("work", "Work", () => { throw new Error("failed"); });
    })).rejects.toThrow("failed");
    const failure = provisioning.snapshot("failure")!;
    expect(failure.steps[0]).toMatchObject({ status: "failed", durationMs: expect.any(Number) });
    const elapsed = failure.totalMs;
    await tick();
    expect(provisioning.snapshot("failure")!.totalMs).toBe(elapsed);
  });

  test("retry stays in the same row, clears stale output, and cannot be submitted twice", async () => {
    const provisioning = createWorkspaceProvisioning();
    let attempts = 0;
    const finished = provisioning.run("one", async (run) => {
      await run.step("prepare", "Prepare", () => {
        if (++attempts === 1) {
          run.report({ output: "failed attempt", terminalSocketPath: "/terminal-processes/old/ws" });
          throw new Error("not ready");
        }
      }, "retry-or-continue");
    });
    await tick();
    expect(provisioning.snapshot("one")).toMatchObject({ status: "waiting", waiting: { stepId: "prepare", retryable: true } });
    expect(provisioning.resume("one", "retry")).toBe("prepare");
    expect(() => provisioning.resume("one", "retry")).toThrow("not waiting");
    await finished;
    expect(attempts).toBe(2);
    expect(provisioning.snapshot("one")?.steps).toEqual([{ id: "prepare", label: "Prepare", status: "done", durationMs: expect.any(Number) }]);
  });

  test("continuing retains the warning and permits subsequent work, but not unsupported retry", async () => {
    const provisioning = createWorkspaceProvisioning();
    let next = false;
    const finished = provisioning.run("one", async (run) => {
      await run.step("setup", "Setup", () => { throw new Error("setup failed"); }, "continue");
      await run.step("next", "Next", () => { next = true; });
    });
    await tick();
    expect(next).toBe(false);
    provisioning.snapshot("one")!.waiting!.retryable = true;
    expect(() => provisioning.resume("one", "retry")).toThrow("does not support retry");
    provisioning.resume("one", "continue");
    await finished;
    expect(next).toBe(true);
    expect(provisioning.snapshot("one")).toMatchObject({ status: "done", steps: [
      { id: "setup", status: "warning", error: "setup failed" }, { id: "next", status: "done" },
    ] });
  });

  test("required failures abort without synthetic steps", async () => {
    const provisioning = createWorkspaceProvisioning();
    let next = false;
    await expect(provisioning.run("one", async (run) => {
      await run.step("required", "Required", () => { throw new Error("failure"); });
      next = true;
    })).rejects.toThrow("failure");
    expect(next).toBe(false);
    expect(provisioning.snapshot("one")).toMatchObject({ status: "failed", error: "failure", steps: [{ id: "required", status: "failed" }] });
    expect(provisioning.snapshot("one")?.steps).toHaveLength(1);
  });

  test("deleting a waiting run releases it without running subsequent work", async () => {
    const provisioning = createWorkspaceProvisioning();
    let next = false;
    const finished = provisioning.run("one", async (run) => {
      await run.step("prepare", "Prepare", () => { throw new Error("not ready"); }, "retry-or-continue");
      next = true;
    });
    const rejected = finished.catch((error: Error) => error);
    await tick();
    provisioning.delete("one");
    expect(await rejected).toMatchObject({ message: "workspace one provisioning cancelled" });
    expect(next).toBe(false);
    expect(provisioning.snapshot("one")).toBeUndefined();
  });

  test("workspaces progress independently and snapshots cannot mutate execution state", async () => {
    const events = createAgentsInTheCloudEventBus();
    const provisioning = createWorkspaceProvisioning({ events });
    const pending = Promise.withResolvers<void>();
    const first = provisioning.run("one", (run) => run.step("slow", "Slow", () => pending.promise));
    await expect(provisioning.run("one", async () => {})).rejects.toThrow("already has an active");
    await provisioning.run("two", (run) => run.step("fast", "Fast", async () => {
      await events.emit("workspace_provision_progress", { workspaceId: "two", detail: "Only two" });
    }));
    const snapshot = provisioning.snapshot("one")!;
    snapshot.steps[0]!.label = "Changed";
    expect(provisioning.snapshot("one")?.steps[0]).toMatchObject({ label: "Slow", status: "running" });
    expect(provisioning.snapshot("one")?.steps[0]?.detail).toBeUndefined();
    pending.resolve();
    await first;
    await provisioning.run("one", (run) => run.step("resume", "Resume", () => {}));
    expect(provisioning.snapshot("one")?.steps.map((step) => step.id)).toEqual(["resume"]);
  });

  test("a failed step can be answered immediately by a change subscriber", async () => {
    const provisioning = createWorkspaceProvisioning({ onChange(id) {
      if (provisioning.snapshot(id)?.waiting) provisioning.resume(id, "continue");
    } });
    await provisioning.run("one", (run) => run.step("setup", "Setup", () => { throw new Error("setup failed"); }, "continue"));
    expect(provisioning.snapshot("one")).toMatchObject({ status: "done", steps: [{ id: "setup", status: "warning" }] });
    expect(provisioning.snapshot("one")?.waiting).toBeUndefined();
  });

  test("a deleted run cannot continue after its in-flight operation finishes", async () => {
    const events = createAgentsInTheCloudEventBus();
    const provisioning = createWorkspaceProvisioning({ events });
    const gate = Promise.withResolvers<void>();
    let next = false;
    const finished = provisioning.run("one", async (run) => {
      await run.step("slow", "Slow", () => gate.promise);
      next = true;
    }).catch((error: Error) => error);
    provisioning.delete("one");
    gate.resolve();
    expect(await finished).toMatchObject({ message: "workspace one provisioning cancelled" });
    expect(next).toBe(false);
    expect(provisioning.snapshot("one")).toBeUndefined();
    await events.emit("workspace_provision_progress", { workspaceId: "one", output: "late output" });
  });

  test("project setup permits explicit continuation, not automatic retry", () => {
    expect(workspaceSetupProvisioningHook.failurePolicy).toBe("continue");
  });
});

test("a hung preparation command times out with its substep and can be retried", async () => {
  const { runCommand } = await import("@agents-in-the-cloud/core");
  const waiting = Promise.withResolvers<void>();
  const provisioning = createWorkspaceProvisioning({ stepTimeoutMs: 100, onChange(id) {
    if (provisioning.snapshot(id)?.status === "waiting") waiting.resolve();
  } });
  let attempts = 0;
  const completed = provisioning.run("hung", (run) => run.step("startup", "Prepare workspace", async () => {
    run.report({ detail: "Importing image postgres:17 into workspace" });
    if (++attempts === 1) await runCommand(["sh", "-c", "sleep 60"]);
  }, "retry-or-continue"));
  await waiting.promise;
  expect(provisioning.snapshot("hung")).toMatchObject({ status: "waiting", waiting: { retryable: true }, steps: [{ status: "failed", error: "Prepare workspace: Importing image postgres:17 into workspace timed out. Retry preparation or delete this workspace." }] });
  provisioning.resume("hung", "retry");
  await completed;
  expect(attempts).toBe(2);
  expect(provisioning.snapshot("hung")?.status).toBe("done");
});

test("cancel waits for operation cleanup and prevents the next step", async () => {
  const { runCommand } = await import("@agents-in-the-cloud/core");
  const provisioning = createWorkspaceProvisioning();
  const cleanup = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let next = false;
  const completed = provisioning.run("cancel", async (run) => {
    await run.step("slow", "Slow", async () => {
      try { await runCommand(["sh", "-c", "sleep 60"]); }
      finally { stopped.resolve(); await cleanup.promise; }
    });
    next = true;
  }).catch((error) => error);
  let settled = false;
  const cancel = provisioning.cancel("cancel").then(() => { settled = true; });
  await stopped.promise;
  expect(settled).toBe(false);
  cleanup.resolve();
  await cancel;
  expect(next).toBe(false);
  expect(await completed).toMatchObject({ message: "workspace cancel provisioning cancelled" });
});

test("required source preparation can retry but cannot be skipped", async () => {
  const waiting = Promise.withResolvers<void>();
  const provisioning = createWorkspaceProvisioning({ onChange(id) {
    if (provisioning.snapshot(id)?.waiting) waiting.resolve();
  } });
  let attempts = 0;
  const finished = provisioning.run("source", (run) => run.step("workspace.source", "Prepare source", () => {
    if (++attempts === 1) throw new Error("Permission denied (publickey)");
  }, "retry"));
  await waiting.promise;
  expect(provisioning.snapshot("source")?.waiting).toEqual({ stepId: "workspace.source", retryable: true, continuable: false });
  expect(() => provisioning.resume("source", "continue")).toThrow("must succeed");
  provisioning.resume("source", "retry");
  await finished;
  expect(attempts).toBe(2);
  expect(provisioning.snapshot("source")?.status).toBe("done");
});

test("shutdown draining waits for executing preparation and rejects new runs", async () => {
  const provisioning = createWorkspaceProvisioning();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const preparation = provisioning.run("active", async (run) => {
    await run.step("configure", "Configure", async () => { entered.resolve(); await release.promise; });
    await run.step("ready", "Ready", () => {});
  });
  await entered.promise;
  let drained = false;
  const shutdown = provisioning.drain().then(() => { drained = true; });
  await Bun.sleep(0);
  expect(drained).toBe(false);
  await expect(provisioning.run("new", async () => {})).rejects.toThrow("shutting down");
  release.resolve();
  await Promise.all([preparation, shutdown]);
  expect(provisioning.snapshot("active")?.status).toBe("done");
});

test("shutdown draining does not wait for user confirmation or admit retries", async () => {
  const provisioning = createWorkspaceProvisioning();
  const preparation = provisioning.run("paused", async (run) => {
    await run.step("ready", "Ready", () => { throw new Error("not ready"); }, "retry-or-continue");
  });
  await Bun.sleep(0);
  expect(provisioning.snapshot("paused")?.status).toBe("waiting");
  await provisioning.drain();
  expect(() => provisioning.resume("paused", "retry")).toThrow("shutting down");
  const cancelled = preparation.catch((error: Error) => error);
  await provisioning.cancel("paused");
  expect(await cancelled).toHaveProperty("message", expect.stringContaining("cancelled"));
});

test("shutdown draining completes when executing work becomes paused", async () => {
  const provisioning = createWorkspaceProvisioning();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const preparation = provisioning.run("active", async (run) => {
    await run.step("ready", "Ready", async () => { entered.resolve(); await release.promise; throw new Error("not ready"); }, "retry");
  });
  await entered.promise;
  const shutdown = provisioning.drain();
  release.resolve();
  await shutdown;
  expect(provisioning.snapshot("active")?.status).toBe("waiting");
  const cancelled = preparation.catch((error: Error) => error);
  await provisioning.cancel("active");
  expect(await cancelled).toHaveProperty("message", expect.stringContaining("cancelled"));
});

for (const phase of ["active", "paused"] as const) for (const action of ["cancel", "delete"] as const) {
  test(`shutdown waits for asynchronous cleanup after ${action} of ${phase === "active" ? "an" : "a"} ${phase} run`, async () => {
    const entered = Promise.withResolvers<void>();
    const paused = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const provisioning = createWorkspaceProvisioning({ onChange(id) {
      if (provisioning.snapshot(id)?.waiting) paused.resolve();
    } });
    const preparation = provisioning.run("preparing", async (run) => {
      try {
        await run.step("ready", "Ready", async () => {
          if (phase === "paused") throw new Error("not ready");
          run.signal.addEventListener("abort", () => interrupted.resolve(), { once: true });
          entered.resolve();
          await interrupted.promise;
        }, "retry");
      } finally {
        cleanupEntered.resolve();
        await cleanup.promise;
      }
    }).catch((error: Error) => error);
    await (phase === "paused" ? paused.promise : entered.promise);
    const cancellation = provisioning[action]("preparing");
    if (action === "delete") expect(provisioning.snapshot("preparing")).toBeUndefined();
    await cleanupEntered.promise;
    let drained = false;
    const shutdown = provisioning.drain().then(() => { drained = true; });
    try {
      await Bun.sleep(0);
      expect(drained).toBe(false);
    } finally {
      cleanup.resolve();
      await Promise.all([cancellation, shutdown]);
    }
    expect(await preparation).toHaveProperty("message", expect.stringContaining("cancelled"));
  });
}
