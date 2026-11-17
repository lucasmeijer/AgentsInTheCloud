import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { availableParallelism } from "node:os";
import type { HostMetric, HostSample, HostSection } from "../protocol.ts";
import { command } from "./command.ts";

export function counters(text: string): Record<string, number> {
  return Object.fromEntries(text.trim().split("\n").filter(Boolean).map(line => { const [key, value] = line.split(/\s+/); return [key!, Number(value)]; }));
}
export function cpuPercent(before: number, after: number, elapsedMs: number, cores: number): number {
  return (after - before) / (elapsedMs * 1000 * cores) * 100;
}
export function effectiveCpu(limits: string[], cpus: number): number {
  return limits.reduce((limit, text) => { const [quota, period] = text.trim().split(/\s+/); return quota === "max" ? limit : Math.min(limit, Number(quota) / Number(period)); }, cpus);
}
export function filesystemUsage(text: string) {
  const fields = text.trim().split("\n").at(-1)!.trim().split(/\s+/);
  if (fields.length < 6) throw new Error("Unrecognized filesystem usage output");
  if (fields[1] === "0" && fields[4] === "-") return null;
  const size = Number(fields[1]);
  const used = Number(fields[2]);
  const available = Number(fields[3]);
  const percent = Number(fields[4]!.replace("%", ""));
  if (![size, used, available, percent].every(Number.isFinite)) throw new Error("Invalid filesystem counters");
  return { size, used, available, percent };
}
const bytes = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GiB`;
const read = (path: string) => readFile(path, "utf8");

export async function sampleHost(root: string, effectiveMemory: number): Promise<HostSample> {
  const started = performance.now();
  const metrics: HostMetric[] = [];
  const sections: HostSection[] = [];
  // Each independent probe reports failures explicitly; one failed subsystem must
  // not erase the remaining evidence from a distressed host.
  async function probe(title: string, collect: () => Promise<string>) {
    try { sections.push({ title, text: await collect() }); }
    catch (error) { sections.push({ title, text: String(error), error: true }); }
  }
  await Promise.all([
    probe("System resources", async () => {
      const paths: string[] = [];
      for (let path = root; path !== "/sys/fs/cgroup"; path = dirname(path)) paths.push(path);
      const cores = effectiveCpu(await Promise.all(paths.map(path => read(join(path, "cpu.max")))), availableParallelism());
      const before = counters(await read(join(root, "cpu.stat")));
      const begin = performance.now();
      await Bun.sleep(1000);
      const after = counters(await read(join(root, "cpu.stat")));
      const elapsed = performance.now() - begin;
      const memory = Number(await read(join(root, "memory.current")));
      const swap = Number(await read(join(root, "memory.swap.current")));
      const percent = cpuPercent(before.usage_usec!, after.usage_usec!, elapsed, cores);
      const throttled = (after.nr_throttled ?? 0) - (before.nr_throttled ?? 0);
      const pressure = await read(join(root, "memory.pressure"));
      const memoryStalls = Number(pressure.match(/^some avg10=([\d.]+)/m)?.[1]);
      const oom = counters(await read(join(root, "memory.events"))).oom_kill ?? 0;
      metrics.push(
        { id: "cpuUsage", value: `${percent.toFixed(1)}% of ${cores.toFixed(2)} CPUs`, warning: percent > 90 },
        { id: "memoryUsage", value: `${bytes(memory)} / ${bytes(effectiveMemory)}`, warning: memory / effectiveMemory > .9 },
        { id: "memoryHeadroom", value: bytes(Math.max(0, effectiveMemory - memory)) },
        { id: "swapUsage", value: bytes(swap), warning: swap > 0 },
        { id: "cpuThrottling", value: `${throttled} periods`, warning: throttled > 0 },
        { id: "memoryStalls", value: `${memoryStalls.toFixed(2)}%`, warning: memoryStalls > 1 },
        { id: "oomKills", value: String(oom), warning: oom > 0 },
      );
      return `System cgroup: ${root}\nCPU capacity includes ancestor quotas and affinity. Memory includes reclaimable cache; headroom is limit minus usage, not MemAvailable.\nCPU counters:\n${await read(join(root, "cpu.stat"))}`;
    }),
    ...["", "management", "workloads"].map(group => probe(`${group || "System"} pressure and limits`, async () => {
      const base = join(root, group);
      const names = ["memory.current", "memory.max", "memory.events", "memory.swap.current", "memory.swap.max", "memory.stat", "cpu.stat", "cpu.pressure", "memory.pressure", "io.pressure", "io.stat", "pids.current", "pids.max", "pids.events"];
      const readings = await Promise.all(names.map(async name => `${name}:\n${await read(join(base, name))}`));
      return readings.join("\n");
    })),
    probe("Disk space", async () => {
      const usage = filesystemUsage(await command(["df", "-P", "-B1", "/data"]))!;
      metrics.push({ id: "diskSpace", value: `${usage.percent}% used · ${bytes(usage.available)} free`, warning: usage.percent >= 90 });
      return command(["df", "-h", "/", "/data"]);
    }),
    probe("Disk inodes", async () => {
      const usage = filesystemUsage(await command(["df", "-P", "-i", "/data"]));
      metrics.push(usage
        ? { id: "diskInodes", value: `${usage.percent}% used · ${usage.available.toLocaleString("en-US")} free`, warning: usage.percent >= 90 }
        : { id: "diskInodes", value: "No fixed limit" });
      return command(["df", "-i", "/", "/data"]);
    }),
    probe("Processes · CPU (lifetime average)", () => command(["sh", "-c", "ps -eo pid,ppid,user,pcpu,rss,stat,comm --sort=-pcpu | head -21"])),
    probe("Processes · resident memory", () => command(["sh", "-c", "ps -eo pid,ppid,user,pcpu,rss,stat,comm --sort=-rss | head -21"])),
    probe("Containers · status and health", () => command(["docker", "ps", "-a", "--format", "table {{.Names}}\t{{.Status}}\t{{.Image}}"])),
    probe("Containers · resource usage", () => command(["docker", "stats", "--no-stream", "--format", "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}\t{{.PIDs}}"], 8000)),
    probe("Docker storage · potentially shared layers", () => command(["docker", "system", "df"], 8000)),
    probe("AgentsInTheCloud service state", () => command(["docker", "inspect", "--format", "{{.Name}} {{json .State}}", "agents-in-the-cloud"])),
  ]);
  sections.sort((a, b) => a.title.localeCompare(b.title));
  return { sampledAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), metrics, sections };
}
