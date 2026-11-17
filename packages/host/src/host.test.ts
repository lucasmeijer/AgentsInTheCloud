import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostService, startHostService } from "./system/service.ts";
import { hostRequest } from "./server/connection.ts";
import { parseHostRequest, type HostSample } from "./protocol.ts";
import { cpuPercent, counters, effectiveCpu, filesystemUsage } from "./system/sampler.ts";

const sample: HostSample = { sampledAt: "2026-01-01T00:00:00.000Z", durationMs: 1000, metrics: [], sections: [] };
const noPrivateNetworkAccess = async () => {};
test("sample cache and concurrent requests share one bounded collection", async () => {
  let count = 0;
  const service = new HostService(async () => { count++; await Bun.sleep(10); return sample; }, noPrivateNetworkAccess);
  await Promise.all([service.handle({ operation: "sample" }), service.handle({ operation: "sample", fresh: true })]);
  expect(count).toBe(1);
  expect(await service.handle({ operation: "sample" })).toEqual(sample);
  expect(count).toBe(1);
  await service.handle({ operation: "sample", fresh: true });
  expect(count).toBe(2);
});
test("failed sampling can be retried", async () => {
  let count = 0;
  const service = new HostService(async () => { if (++count === 1) throw new Error("broken"); return sample; }, noPrivateNetworkAccess);
  await expect(service.handle({ operation: "sample" })).rejects.toThrow("broken");
  expect(await service.handle({ operation: "sample" })).toEqual(sample);
});
test("CPU uses interval usage and the tightest ancestor quota", () => {
  expect(effectiveCpu(["max 100000", "150000 100000", "200000 100000"], 8)).toBe(1.5);
  expect(cpuPercent(1000, 751000, 1000, 1.5)).toBe(50);
  expect(counters("usage_usec 42\nnr_throttled 3\n")).toEqual({ usage_usec: 42, nr_throttled: 3 });
});
test("disk and inode usage validate df output", () => {
  expect(filesystemUsage("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 91 9 91% /data")).toEqual({ size: 100, used: 91, available: 9, percent: 91 });
  expect(filesystemUsage("Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/loop0 0 0 0 - /data")).toBeNull();
  expect(() => filesystemUsage("broken")).toThrow();
});
test("control boundary rejects every operation but sampling and private network access", () => {
  for (const operation of ["exec", "list", "create", "terminate", "attach"]) {
    expect(() => parseHostRequest(JSON.stringify({ operation, id: `host-${crypto.randomUUID()}` }))).toThrow();
  }
});
test("private network access replaces destinations through the System handler", async () => {
  const destinations = [{ bridge: "atw-0123456789a", address: "10.1.2.3", port: 5432 }];
  let received: unknown;
  const service = new HostService(async () => sample, async value => { received = value; });
  expect(parseHostRequest(JSON.stringify({ operation: "private-network-access", destinations }))).toEqual({ operation: "private-network-access", destinations });
  expect(await service.handle({ operation: "private-network-access", destinations })).toBeNull();
  expect(received).toEqual(destinations);
  for (const destination of [{ ...destinations[0], bridge: 1 }, { ...destinations[0], port: "5432" }, { ...destinations[0], extra: true }])
    expect(() => parseHostRequest(JSON.stringify({ operation: "private-network-access", destinations: [destination] }))).toThrow();
});

test("the private socket answers one request per connection, and reports failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-service-"));
  const socketPath = join(directory, "control.sock");
  const received: unknown[] = [];
  const server = await startHostService({ socketPath, root: "/unused", effectiveMemory: 0, privateNetworkAccess: async destinations => {
    received.push(destinations);
    if (!destinations.length) throw new Error("no destinations");
  } });
  try {
    const destinations = [{ bridge: "atw-0123456789a", address: "10.1.2.3", port: 5432 }];
    expect(await hostRequest({ operation: "private-network-access", destinations }, socketPath)).toBeNull();
    await expect(hostRequest({ operation: "private-network-access", destinations: [] }, socketPath)).rejects.toThrow("no destinations");
    expect(received).toEqual([destinations, []]);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
