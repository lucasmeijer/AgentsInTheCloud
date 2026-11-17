// Builds the System image and boots it like an installation does, then checks
// that System can run an app and serve it the private host socket.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { command } from "./src/process.ts";
import type { HostCommand } from "../../packages/host/src/protocol.ts";

const id = crypto.randomUUID().slice(0, 8);
const systemImage = `agents-in-the-cloud-system:boot-test-${id}`;
const appImage = `agents-in-the-cloud-boot-test-app:${id}`;
const container = `agents-in-the-cloud-boot-test-${id}`;
const volume = container;
const root = new URL("../..", import.meta.url).pathname;
// The smallest app System accepts: something healthy on port 3000. Small, because
// copying it into System's Docker daemon is most of this test's time.
const appDockerfile = `FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092
RUN mkdir /www && printf ready > /www/up
CMD ["httpd", "-f", "-p", "127.0.0.1:3000", "-h", "/www"]
`;

const minutes = (count: number) => count * 60_000;
const exec = (...args: string[]) => command(["docker", "exec", container, ...args], undefined, minutes(2));
async function fetchInSystem(url: string, init?: { method: "POST"; body: { localPort: number } }): Promise<{ status: number; body: string }> {
  const request = init ? `{method:"POST",headers:{"content-type":"application/json"},body:${JSON.stringify(JSON.stringify(init.body))}}` : "{}";
  return JSON.parse(await exec("bun", "-e", `const r=await fetch(${JSON.stringify(url)},${request});console.log(JSON.stringify({status:r.status,body:await r.text()}));`));
}
const status = async () => JSON.parse((await fetchInSystem("http://127.0.0.1:3001/status")).body);
async function hostRequestLine(line: string): Promise<any> {
  return JSON.parse(await exec("bun", "-e", `const s=require("node:net").createConnection("/run/agents-in-the-cloud-host/control.sock");let t="";s.on("data",d=>t+=d);s.on("end",()=>console.log(t.trim()));s.write(${JSON.stringify(`${line}\n`)});`));
}
const hostRequest = (request: HostCommand) => hostRequestLine(JSON.stringify(request));
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, description: string, timeout = minutes(3)): Promise<T> {
  const end = Date.now() + timeout;
  let last: T | Error | undefined;
  while (Date.now() < end) {
    last = await read().catch((error: Error) => error);
    if (!(last instanceof Error) && done(last)) return last;
    if (await command(["docker", "inspect", "-f", "{{.State.Running}}", container]) !== "true") break;
    await Bun.sleep(100);
  }
  const logs = await command(["docker", "logs", "--tail", "50", container]).catch(String);
  throw new Error(`${description}: ${last instanceof Error ? last.message : JSON.stringify(last)}\n${logs}`);
}

beforeAll(async () => {
  const app = Bun.spawn(["docker", "build", "-q", "-t", appImage, "-"], { stdin: new Blob([appDockerfile]), stdout: "pipe", stderr: "pipe" });
  await command(["bash", `${root}images/system/build.sh`, "-q", "-t", systemImage], undefined, minutes(15));
  if (await app.exited !== 0) throw new Error(`Building the app image failed: ${await new Response(app.stderr).text()}`);
  await command(["docker", "run", "-d", "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--name", container,
    "--mount", `source=${volume},target=/data`, systemImage, "--access-mode", "localhost", "--app-image", appImage]);
}, minutes(25));

afterAll(async () => {
  await command(["docker", "rm", "-f", container]).catch(() => undefined);
  await command(["docker", "volume", "rm", volume]).catch(() => undefined);
  await command(["docker", "image", "rm", systemImage, appImage]).catch(() => undefined);
}, minutes(1));

test("System boots, starts its app, and serves the host socket", async () => {
  await until(() => exec("docker", "info"), () => true, "System's Docker daemon starts");
  expect((await fetchInSystem("http://127.0.0.1:3001/status")).status).toBe(200);
  const hostChecks = Promise.all([
    hostRequest({ operation: "sample" }),
    hostRequest({ operation: "private-network-access", destinations: [] }),
    hostRequestLine(JSON.stringify({ operation: "list" })),
  ]);

  const save = Bun.spawn(["docker", "save", appImage], { stdout: "pipe" });
  const load = Bun.spawn(["docker", "exec", "-i", container, "docker", "load"], { stdin: save.stdout, stdout: "ignore", stderr: "inherit" });
  expect([await save.exited, await load.exited]).toEqual([0, 0]);
  expect((await fetchInSystem("http://127.0.0.1:3001/access", { method: "POST", body: { localPort: 4321 } })).status).toBe(200);

  const ready = await until(status, (s) => s.healthy === true || !!s.failure, "app becomes healthy");
  expect(ready.failure).toBeUndefined();

  const [app, workspace] = await Promise.all([
    fetchInSystem("http://127.0.0.1:3000/up"),
    exec("docker", "run", "--rm", appImage, "echo", "workspace ran"),
    exec("docker", "exec", "agents-in-the-cloud", "test", "-S", "/run/agents-in-the-cloud-host/control.sock"),
  ]);
  expect(app).toEqual({ status: 200, body: "ready" });
  const [sample, privateNetworkAccess, removedOperation] = await hostChecks;
  expect(sample.type).toBe("result");
  expect(sample.value.metrics.length).toBeGreaterThan(0);
  expect(privateNetworkAccess).toEqual({ type: "result", value: null });
  expect(removedOperation.type).toBe("error");
  expect(workspace).toBe("workspace ran");
}, minutes(6));
