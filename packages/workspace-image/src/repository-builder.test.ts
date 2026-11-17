import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const scenario of ["new", "warm", "stopped", "upgrade", "unavailable", "build-failed", "publish-failed"] as const) {
  test(`repository builder: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "repository-builder-unit-"));
    try {
      const runtimeImage = (await readFile(new URL("../runtime-image", import.meta.url), "utf8")).trim();
      await writeFile(join(directory, "test.ts"), `
        import {mock} from 'bun:test';
        const corePath = ${JSON.stringify(join(import.meta.dir, "../../core/src/index.ts"))};
        const core = await import(corePath);
        const calls = [];
        const scenario = ${JSON.stringify(scenario)};
        let exists = ['warm','stopped','upgrade'].includes(scenario);
        mock.module(corePath, () => ({...core,
          getAgentsInTheCloudRuntimeContext: () => ({agentsInTheCloudDataDir:${JSON.stringify(directory)},dockerHostAgentsInTheCloudDataDir:'/host/app'}),
          workloadCgroupArgs: async () => ['--cgroup-parent','system-workloads'],
          requireDocker: async args => {
            calls.push(args);
            let stdout = '';
            if(args[0] === '--host') stdout = args.includes('ls') && scenario==='warm' ? 'sha256:base' : '';
            else if(args[0] === 'run' && args.includes('--rm')) stdout=JSON.stringify({hosts:['unix:///var/run/docker.sock'],'runtime-setting':'preserved'});
            else if(args[0] === 'ps') stdout = exists ? 'builder-id' : '';
            else if(args[0] === 'inspect') stdout = JSON.stringify([{Config:{Image:scenario==='upgrade'?'old-runtime':${JSON.stringify(runtimeImage)}},State:{Running:scenario!=='stopped'}}]);
            else if(args[0] === 'image') stdout = 'sha256:base';
            else if(args[0] === 'rm') exists = false;
            else if(args[0] === 'run') exists = true;
            else if(args[0] === 'exec' && scenario==='unavailable') throw Error('builder not ready');
            return {exitCode:0,stdout,stderr:''};
          },
          runCommand: async args => {
            calls.push(args);
            const publishing = args[0]==='bash' && args.at(-1).includes('result:tag');
            return {exitCode:publishing&&scenario==='publish-failed'?1:0,stdout:Buffer.from(''),stderr:publishing&&scenario==='publish-failed'?'load failed':''};
          },
        }));
        const buildNetworkPath = ${JSON.stringify(join(import.meta.dir, "build-network.ts"))};
        const buildNetwork = await import(buildNetworkPath);
        mock.module(buildNetworkPath, () => ({...buildNetwork,
          repositoryBuildCommand: async args => buildNetwork.protectedRepositoryBuildCommand({buildClientNetworkPolicy:1}, args),
        }));
        const {buildRepositoryImage} = await import(${JSON.stringify(join(import.meta.dir, "repository-builder.ts"))});
        let error;
        try { await buildRepositoryImage('base:tag','result:tag',async prefix=>{
          calls.push(['BUILD',...prefix]);
          if(scenario==='build-failed')throw Error('build failed');
        }); } catch(e) { error=e.message; }
        console.log(JSON.stringify({calls,error}));
      `);
      const child = Bun.spawn([process.execPath, join(directory, "test.ts")], { stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      const result: { calls: string[][]; error?: string } = JSON.parse(stdout);
      const [identity] = await readdir(join(directory, "repository-builder"));
      const control = join(directory, "repository-builder", identity!);
      expect((await stat(control)).mode & 0o777).toBe(0o700);
      const run = result.calls.find(args => args[0] === "run" && args.includes("--name"));
      const readConfig = result.calls.find(args => args[0] === "run" && args.includes("--rm"));
      expect(result.calls.filter(args => args[0] === "ps")).toHaveLength(1);
      if (["warm", "stopped"].includes(scenario)) {
        expect(readConfig).toBeUndefined();
        expect(await readdir(control)).toEqual([]);
      } else {
        expect(readConfig).toEqual(["run", "--rm", "--network=none", "--entrypoint", "cat", runtimeImage, "/etc/docker/daemon.json"]);
        const daemon = JSON.parse(await readFile(join(control, "daemon.json"), "utf8"));
        expect(daemon).toEqual({ hosts: ["unix:///control/docker.sock"], "runtime-setting": "preserved" });
      }
      if (["warm", "stopped"].includes(scenario)) expect(run).toBeUndefined();
      else {
        expect(run).toContain(runtimeImage);
        expect(run).toContain("type=volume,src=" + run![run!.indexOf("--name") + 1] + ",dst=/data");
        expect(run).toContain("--cgroup-parent");
        expect(run).toContain("system-workloads");
        expect(run).not.toContain("host");
        expect(run!.join(" ")).not.toContain("/var/run/docker.sock");
        expect(run!.join(" ")).not.toContain("/run/containerd/containerd.sock");
        expect(run!.join(" ")).not.toContain("--publish");
      }
      if (scenario === "stopped") expect(result.calls.some(args => args[0] === "start")).toBe(true);
      if (scenario === "upgrade") {
        expect(result.calls.findIndex(args => args[0] === "stop")).toBeLessThan(result.calls.findIndex(args => args[0] === "rm"));
        expect(result.calls.findIndex(args => args[0] === "rm")).toBeLessThan(result.calls.findIndex(args => args[0] === "run"));
      }
      const build = result.calls.find(args => args[0] === "BUILD");
      const pipes = result.calls.filter(args => args[0] === "bash");
      for (const pipe of pipes) expect(pipe.slice(0, 4)).toEqual(["bash", "-o", "pipefail", "-c"]);
      if (scenario === "unavailable") {
        expect(build).toBeUndefined();
        expect(pipes).toEqual([]);
        expect(result.error).toBe("builder not ready");
      } else {
        expect(build!.slice(0, 3)).toEqual(["BUILD", "sh", "-ec"]);
        expect(build![3]).toContain("build-client-processes/cgroup.procs");
        expect(build!.slice(4, 7)).toEqual(["agents-in-the-cloud-build", "docker", "--host"]);
        expect(build![7]).toStartWith(`unix://${directory}/repository-builder/`);
        expect(build![7]).toEndWith("/docker.sock");
        expect(pipes.some(args => args.at(-1)!.includes("sha256:base"))).toBe(scenario !== "warm");
        expect(pipes.some(args => args.at(-1)!.includes("result:tag"))).toBe(scenario !== "build-failed");
        expect(result.error).toBe(scenario === "build-failed" ? "build failed" : scenario === "publish-failed" ? "load failed" : undefined);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
