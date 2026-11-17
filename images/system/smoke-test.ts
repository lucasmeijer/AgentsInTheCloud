// Protocol/lifecycle integration checks. Run against a disposable installed System
// with agents-in-the-cloud-test:{v1,v2,broken,retry} loaded into its inner Docker daemon.
import { strict as assert } from "node:assert";
import { parseArgs } from "node:util";
import { command, sleep } from "./src/process.ts";
const { values } = parseArgs({
  options: {
    host: { type: "string" },
    container: { type: "string", default: "agents-in-the-cloud-system" },
  },
});
const prefix = ["docker", ...(values.host ? ["--host", values.host] : [])];
const exec = (...args: string[]) =>
  command([...prefix, "exec", values.container!, ...args]);
const docker = (...args: string[]) => exec("docker", ...args);
async function api(
  path: string,
  method = "GET",
  data?: { image: string } | { mode: "localhost" | "tailscale" },
  port = 3001,
): Promise<any> {
  const code = `const r=await fetch(${JSON.stringify(`http://127.0.0.1:${port}${path}`)},{method:${JSON.stringify(method)},headers:{"content-type":"application/json"},body:${data === undefined ? "undefined" : JSON.stringify(JSON.stringify(data))}});console.log(JSON.stringify({status:r.status,body:await r.text()}));`;
  const response = JSON.parse(await exec("bun", "-e", code));
  assert(response.status < 400, `${path}: ${response.status} ${response.body}`);
  return response.body ? JSON.parse(response.body) : null;
}
async function status() {
  return api("/status");
}
async function until(
  check: () => Promise<boolean>,
  description: string,
  seconds = 150,
) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`${description}: ${JSON.stringify(await status())}`);
}
async function update(image: string) {
  assert.equal((await api("/update", "POST", { image })).accepted, true);
}
async function healthy(version: string) {
  await until(
    async () =>
      (await status()).healthy &&
      (await api("/state", "GET", undefined, 3000)).version === version,
    `healthy ${version}`,
  );
}
await until(async () => !(await status()).busy, "System idle");
await update("agents-in-the-cloud-test:v1");
await healthy("v1");
const original = await api("/state", "GET", undefined, 3000);
const workspace = await docker(
  "run",
  "-d",
  "--name",
  "agents-in-the-cloud-smoke-workspace",
  "--mount",
  "source=agents-in-the-cloud-smoke-workspace,target=/data",
  "--entrypoint",
  "/bin/sh",
  "agents-in-the-cloud-test:v1",
  "-c",
  "echo preserved > /data/marker; exec sleep infinity",
);
const before = JSON.parse(await docker("inspect", workspace))[0];
// Subscribe to the public protocol, not a browser/DOM. Operation continues once
// the request that initiated it has finished, independently of this observer.
await update("agents-in-the-cloud-test:v2");
const events = exec(
  "bun",
  "-e",
  'const r=await fetch("http://127.0.0.1:3001/events");const reader=r.body.getReader();let text="";while(true){const v=await reader.read();if(v.done)break;text+=new TextDecoder().decode(v.value);if(text.includes("event: ready")){console.log(text);await reader.cancel();break;}}',
);
await healthy("v2");
const stream = await events;
assert(stream.includes("event: progress"));
assert(stream.includes("event: ready"));
assert.equal(
  (await api("/state", "GET", undefined, 3000)).marker,
  original.marker,
);
const after = JSON.parse(await docker("inspect", workspace))[0];
assert.equal(after.Id, before.Id);
assert.equal(after.State.StartedAt, before.State.StartedAt);
assert(after.State.Running);
assert.equal(
  await docker("exec", workspace, "cat", "/data/marker"),
  "preserved",
);
console.log(
  "PASS: v1 → v2, SSE progress, detached operation, persisted app state, uninterrupted workspace",
);
const concurrent = JSON.parse(
  await exec(
    "bun",
    "-e",
    'const send=()=>fetch("http://127.0.0.1:3001/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({image:"agents-in-the-cloud-test:v2"})}).then(r=>r.status);console.log(JSON.stringify((await Promise.all([send(),send()])).sort()));',
  ),
);
assert.deepEqual(concurrent, [202, 409]);
await healthy("v2");
console.log("PASS: concurrent app updates serialize");
await update("agents-in-the-cloud-test:broken");
await until(
  async () => !!(await status()).failure && !(await status()).busy,
  "broken startup timeout",
);
assert(
  (await status()).logs.some((line: string) =>
    line.includes("TEST_STARTUP_FAILURE"),
  ),
);
console.log("PASS: broken startup timeout and container logs");
await exec("touch", "/data/app/fail-startup");
await update("agents-in-the-cloud-test:retry");
await until(
  async () => !!(await status()).failure && !(await status()).busy,
  "retry fixture failure",
);
await exec("rm", "/data/app/fail-startup");
assert.equal(
  await exec(
    "bun",
    "-e",
    'const r=await fetch("http://127.0.0.1:3001/retry",{method:"POST",redirect:"manual"});console.log(r.status)',
  ),
  "303",
);
await healthy("retry");
console.log("PASS: retry succeeds after correcting startup condition");
await docker("kill", "agents-in-the-cloud");
await until(
  async () => !(await status()).healthy && !!(await status()).failure,
  "running app failure",
);
await update("agents-in-the-cloud-test:v2");
await healthy("v2");
console.log("PASS: running app failure visible; restored v2 for manual review");
const selected = (await status()).currentImage;
await command([...prefix, "restart", "--timeout", "120", values.container!]);
await until(async () => {
  try {
    return (await status()).healthy;
  } catch {
    return false;
  }
}, "System restart");
await healthy("v2");
assert.equal((await status()).currentImage, selected);
const restored = JSON.parse(await docker("inspect", workspace))[0];
assert.equal(restored.Id, before.Id);
assert(restored.State.Running);
assert.equal(
  await docker("exec", workspace, "cat", "/data/marker"),
  "preserved",
);
assert.equal(
  (await api("/state", "GET", undefined, 3000)).marker,
  original.marker,
);
console.log(
  "PASS: System restart restores selected app and running workspace with persistent data",
);
console.log(
  JSON.stringify({
    workspace,
    currentImage: (await status()).currentImage,
    marker: original.marker,
  }),
);

if ((await api("/access")).mode === "localhost") {
  const tailscaleRunning = async () => (await exec("sh", "-c", "if pgrep -x tailscaled > /dev/null; then echo running; else echo stopped; fi")) === "running";
  assert.equal(await tailscaleRunning(), false, "local startup must leave Tailscale stopped");
  await api("/access", "POST", { mode: "tailscale" });
  assert.equal((await api("/access")).mode, "tailscale", "Tailscale choice must be saved before sign-in");
  await until(tailscaleRunning, "Tailscale starts on request");
  await api("/access", "POST", { mode: "localhost" });
  await until(async () => !await tailscaleRunning(), "Tailscale stops in computer-only mode");
  const access = await api("/access");
  assert.equal(access.connectionState, "Stopped");
  assert.equal(access.authUrl, undefined);
  assert.equal(access.origin, `http://agents-in-the-cloud.localhost:${access.localPort}`, "access URL must return to the installation computer after disconnecting Tailscale");
  assert.equal((await status()).healthy, true, "switching connection mode must not restart the app");
  console.log("PASS: local mode leaves Tailscale stopped; explicit selection starts it; computer-only mode stops it without restarting the app");
}
