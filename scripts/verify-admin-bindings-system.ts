// Real, disposable System/Docker integration. Never targets an existing installation.
// Requires locally built app + System images; creates and cleans its own containers/volume.
import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createAdminStore, adminScopes } from "../apps/web/src/server/admin/store.ts";

const { values } = parseArgs({ options: { app: { type: "string", default: "agents-in-the-cloud-admin:local" }, system: { type: "string", default: "agents-in-the-cloud-system:admin-local" }, workspace: { type: "string", default: "agents-in-the-cloud-admin-workspace:ec5a028713912422" } } });
const name = `aitc-admin-integration-${crypto.randomUUID().slice(0, 8)}`;
const volume = name;
const fixtureApp = `${name}:app`;
const hostPort = 35000 + Math.floor(Math.random() * 4000);
const directory = await mkdtemp(join(tmpdir(), "aitc-admin-system-"));
async function run(args: string[], input?: string) {
  const child = Bun.spawn(args, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`Integration command ${args[0]} ${args[1]} failed (${exit})${args.includes("-e") ? ": details suppressed for credential safety" : `: ${stderr.slice(0, 800)}`}`);
  return stdout.trim();
}
const exec = (...args: string[]) => run(["docker", "exec", name, ...args]);
async function until(check: () => Promise<boolean>, label: string, milliseconds = 180_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(500); }
  throw new Error(`Timed out: ${label}`);
}
try {
  await run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  await chmod(join(directory, "key.pem"), 0o600);
  const store = createAdminStore(join(directory, "admin-bindings.json"));
  await store.setBindings([{ host: "0.0.0.0", port: 3443, tls: { cert: "/data/app/admin-tls/cert.pem", key: "/data/app/admin-tls/key.pem" } }]);
  const issued = await store.issue({ name: "integration", scopes: [...adminScopes] });
  const cert = await readFile(join(directory, "cert.pem"), "utf8");
  // Start only dockerd for preloading, as in the existing System bootstrap test.
  await run(["docker", "run", "-d", "--name", name, "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--mount", `source=${volume},target=/data`, "--entrypoint", "/usr/local/bin/agents-in-the-cloud-dockerd", values.system!, "dockerd"]);
  await until(async () => (await exec("docker", "info").then(() => true, () => false)), "inner Docker daemon");
  const save = Bun.spawn(["docker", "save", values.app!, values.workspace!], { stdout: "pipe", stderr: "pipe" });
  const load = Bun.spawn(["docker", "exec", "-i", name, "docker", "load"], { stdin: save.stdout, stdout: "pipe", stderr: "pipe" });
  const outputs = await Promise.all([save.exited, load.exited, new Response(save.stderr).text(), new Response(load.stderr).text(), new Response(load.stdout).text()]);
  assert.equal(outputs[0], 0, "image save"); assert.equal(outputs[1], 0, "inner image load");
  // These are local, preloaded images, not registry releases: suppress eager pulls in this disposable fixture.
  await run(["docker", "exec", "-i", name, "docker", "build", "-t", fixtureApp, "-"], `FROM ${values.app}\nLABEL eagerly-preload="[]"\n`);
  await exec("mkdir", "-p", "/data/app/admin-tls");
  for (const file of ["key.pem", "cert.pem"]) await run(["docker", "cp", join(directory, file), `${name}:/data/app/admin-tls/${file}`]);
  await run(["docker", "cp", join(directory, "admin-bindings.json"), `${name}:/data/app/admin-bindings.json`]);
  await exec("chown", "-R", "1000:1000", "/data/app");
  await exec("chmod", "700", "/data/app/admin-tls");
  await run(["docker", "stop", "--time", "60", name]); await run(["docker", "rm", name]);
  await run(["docker", "run", "-d", "--name", name, "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--publish", `127.0.0.1:${hostPort}:3443`, "--publish", `127.0.0.1:${hostPort + 1}:3080`, "--mount", `source=${volume},target=/data`, values.system!, "--app-image", fixtureApp, "--access-mode", "localhost"]);
  const localPort = Number(await run(["docker", "inspect", "--format", '{{(index (index .HostConfig.PortBindings "3080/tcp") 0).HostPort}}', name]));
  await until(async () => (await exec("bun", "-e", `const r=await fetch("http://127.0.0.1:3001/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode:"localhost",localPort:${localPort}})});process.exit(r.ok?0:1);`).then(() => true, () => false)), "installer local-port registration");
  await until(async () => (await exec("bun", "-e", 'const r=await fetch("http://127.0.0.1:3001/status");process.exit((await r.json()).healthy?0:1)').then(() => true, () => false)), "real System app health");
  const mappingTemplate = '{{range $port, $bindings := .HostConfig.PortBindings}}{{if ne $port "3080/tcp"}}{{range $bindings}}{{.HostIp}}:{{.HostPort}}:{{$port}}{{println}}{{end}}{{end}}{{end}}';
  const mapping = await run(["docker", "inspect", "--format", mappingTemplate, name]);
  const port = Number(mapping.split(":")[1]);
  assert(port > 0);
  async function api(path: string, method = "GET", body = "", token: string | null = issued.secret) {
    // Client is a separate container in the Docker host network namespace, not a server-side loopback request.
    const code = `const headers={"content-type":"application/json"};${token ? `headers.authorization=${JSON.stringify(`Bearer ${token}`)};` : ""}const r=await fetch(${JSON.stringify(`https://127.0.0.1:${port}${path}`)},{method:${JSON.stringify(method)},headers,${method === "GET" ? "" : `body:${JSON.stringify(body)},`}tls:{ca:${JSON.stringify(cert)}}});console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
    return JSON.parse(await run(["docker", "run", "--rm", "--network", "host", "--entrypoint", "bun", values.app!, "-e", code]));
  }
  assert.equal((await api("/workspaces", "GET", "", null)).status, 401);
  assert.equal((await api("/workspaces")).status, 200);
  assert.equal((await api("/settings/access")).body.mode, "localhost");
  assert.equal((await api("/settings/access", "POST", '{"mode":"localhost"}')).status, 200);
  const status = await api("/host/status");
  assert.equal(status.status, 200); assert.equal(status.body.healthy, true);
  assert.equal(status.body.connectionState, "Stopped");
  assert.equal((await api("/host/sample")).status, 200);
  assert.equal((await api("/host/terminals")).status, 404);
  const cli = JSON.parse(await exec("docker", "exec", "--user", "1000:1000", "agents-in-the-cloud", "bun", "/app/apps/web/scripts/admin-bindings.ts", "show"));
  assert.equal(cli.tokens.length, 1);
  // Deliberately corrupt optional configuration, then verify real UI health after app restart.
  await exec("sh", "-c", 'printf "bad JSON" > /data/app/admin-bindings.json');
  await exec("docker", "restart", "--time", "30", "agents-in-the-cloud");
  await until(async () => (await exec("bun", "-e", 'const r=await fetch("http://127.0.0.1:3000/up");process.exit(r.status===200?0:1)').then(() => true, () => false)), "UI survives corrupt optional admin configuration");
  await run(["docker", "stop", "--time", "60", name]);
  assert.equal(await run(["docker", "inspect", "--format", mappingTemplate, name]), mapping, "persistent mappings survive stopped System");
  console.log("PASS: real System, TLS publication, separate client container, nested CLI, access/status/diagnostics, startup isolation, stopped-container publication persistence");
} finally {
  await run(["docker", "rm", "-f", name]).catch(() => {});
  await run(["docker", "volume", "rm", volume]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
