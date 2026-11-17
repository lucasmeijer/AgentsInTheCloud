import { escapeHtml } from "../../../packages/shared/src/html.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { button, page } from "./ui.ts";
import { command } from "./process.ts";
const version = (
  await readFile(new URL("./version", import.meta.url), "utf8")
).trim();
const mode = (
  await readFile(new URL("./mode", import.meta.url), "utf8")
).trim();
await mkdir("/data/app", { recursive: true });
const markerFile = "/data/app/test-app-marker";
if (!(await Bun.file(markerFile).exists()))
  await writeFile(markerFile, `created by ${version}`);
const marker = await readFile(markerFile, "utf8");
const started = Date.now();
console.log(
  `Starting AgentsInTheCloud test app ${version}; mode=${mode}; persisted=${marker}`,
);
if (mode === "broken")
  console.error("TEST_STARTUP_FAILURE: deliberately unhealthy fixture");
Bun.serve({
  hostname: "127.0.0.1",
  port: 3000,
  async fetch(request) {
    const url = new URL(request.url);
    const failed =
      mode === "broken" ||
      (mode === "retry" && (await Bun.file("/data/app/fail-startup").exists()));
    const ready = !failed && (mode !== "slow" || Date.now() - started >= 5000);
    if (url.pathname === "/up")
      return new Response(ready ? "ready" : "starting", {
        status: ready ? 200 : 503,
      });
    if (url.pathname === "/state")
      return Response.json({ version, marker, ready });
    if (url.pathname === "/client.js" || url.pathname === "/design-system.css")
      return new Response(
        Bun.file(new URL(`.${url.pathname}`, import.meta.url)),
      );
    if (url.pathname === "/update" && request.method === "POST") {
      if (
        request.headers.get("origin") &&
        new URL(request.headers.get("origin")!).host !== url.host
      )
        return new Response("Forbidden", { status: 403 });
      const form = await request.formData();
      const image = form.get("image");
      if (
        !Value.Check(Type.String({ minLength: 1, pattern: "^(?!-)[^\\s]+$" }), image)
      )
        return new Response("Expected image reference", { status: 400 });
      if (!(await command(["docker", "image", "ls", "-q", image])))
        await command(["docker", "pull", image]);
      const response = await fetch("http://127.0.0.1:3001/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image }),
      });
      if (!response.ok)
        return new Response(await response.text(), { status: response.status });
      return Response.redirect(
        request.headers.get("origin") ?? url.origin,
        303,
      );
    }
    return new Response(
      page(
        `AgentsInTheCloud test app ${version}`,
        `<h1>AgentsInTheCloud test app ${escapeHtml(version)}</h1><p>Persistent marker: ${escapeHtml(marker)}</p><form method="post" action="/update"><label>Prepared image <input class="text-field" name="image" required value="agents-in-the-cloud-test:v2"></label>${button("Update")}</form>`,
      ),
      { headers: { "content-type": "text/html" } },
    );
  },
});
if (mode === "slow")
  setTimeout(
    () => console.log("Startup steps complete; health endpoint is ready"),
    5000,
  );
