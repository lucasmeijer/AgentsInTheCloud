import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchVSCodeWorkspaceAppResponse } from "../src/server/proxy.ts";
import { vscodeFileNavigationStream } from "../src/server/render.ts";
import { vscodeOpenFileScript } from "../src/server/startup.ts";

const app = { appKey: "vscode", workspaceId: "navigation" };

async function navigationResponse(path: string, gotoLine = false): Promise<Response> {
  const url = new URL("https://workspace.example:41000/");
  url.searchParams.set("agentsInTheCloudOpenFile", path);
  if (gotoLine) url.searchParams.set("agentsInTheCloudGotoLine", "1");
  url.searchParams.set("agentsInTheCloudBg", "#112233");
  const response = new Response("", { headers: { "content-type": "text/html" } });
  return patchVSCodeWorkspaceAppResponse(app, response, new Request(url));
}

test("file navigation redirects to VS Code's native payload on this browser's app origin", async () => {
  const response = await navigationResponse("/work/example.ts:42:3", true);
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const target = new URL(response.headers.get("location")!);
  expect(target.origin).toBe("https://workspace.example:41000");
  expect(JSON.parse(target.searchParams.get("payload")!)).toEqual([
    ["openFile", "vscode-remote://workspace.example:41000/work/example.ts:42:3"],
    ["gotoLineMode", "true"],
  ]);
  expect(target.searchParams.has("agentsInTheCloudOpenFile")).toBe(false);
  expect(target.searchParams.has("agentsInTheCloudGotoLine")).toBe(false);
  expect(target.searchParams.get("agentsInTheCloudBg")).toBe("#112233");
});

test("literal path punctuation is URI encoded and is not treated as a cursor position", async () => {
  const response = await navigationResponse("/work/a b#c%20?.ts:42");
  const target = new URL(response.headers.get("location")!);
  expect(JSON.parse(target.searchParams.get("payload")!)).toEqual([
    ["openFile", "vscode-remote://workspace.example:41000/work/a%20b%23c%2520%3F.ts:42"],
  ]);
});

test("the app boundary rejects relative file paths", async () => {
  expect((await navigationResponse("relative.ts")).status).toBe(422);
});

async function runOpenFileScript(windows: Array<"accepts" | "refuses">): Promise<{ stdout: string; opened: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), "vscode-open-file-"));
  const listeners = windows.map((_, index) => Bun.listen({ unix: join(directory, `vscode-ipc-${index}.sock`), socket: { data() {} } }));
  try {
    const cli = join(directory, "code");
    await writeFile(cli, `#!/bin/sh\ncase "$VSCODE_IPC_HOOK_CLI" in ${windows.map((mode, index) => `*-${index}.sock) ${mode === "accepts" ? `echo "$VSCODE_IPC_HOOK_CLI $*" >> '${directory}/opened'` : "exit 1"} ;;`).join(" ")} esac\n`, { mode: 0o755 });
    const script = vscodeOpenFileScript("/work/it's here.ts:4:2", true)
      .replaceAll("/tmp/vscode-ipc-", join(directory, "vscode-ipc-"))
      .replaceAll("/opt/agents-in-the-cloud/vscode-server/bin/remote-cli/code", cli);
    const process = Bun.spawn(["sh", "-c", script], { stdout: "pipe" });
    const [, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
    const openedFile = Bun.file(join(directory, "opened"));
    const opened = await openedFile.exists() ? (await openedFile.text()).trim().split("\n") : [];
    return { stdout, opened: opened.map((line) => line.replace(directory, "")) };
  } finally {
    listeners.forEach((listener) => listener.stop(true));
    await rm(directory, { recursive: true, force: true });
  }
}

test("an open VS Code window receives the file without reloading", async () => {
  const { stdout, opened } = await runOpenFileScript(["refuses", "accepts"]);
  expect(stdout.trim()).toBe("delivered");
  expect(opened).toEqual(["/vscode-ipc-1.sock -r --goto /work/it's here.ts:4:2"]);
});

test("without a live VS Code window nothing is delivered", async () => {
  expect((await runOpenFileScript([])).stdout.trim()).toBe("");
  expect((await runOpenFileScript(["refuses"])).stdout.trim()).toBe("");
});

test("the navigation signal tells the browser whether its VS Code already has the file", () => {
  expect(vscodeFileNavigationStream("navigation", "VS Code", { path: "/work/a.ts" }, true)).toContain('data-vscode-navigate-delivered-value="true"');
  expect(vscodeFileNavigationStream("navigation", "VS Code", { path: "/work/a.ts" }, false)).toContain('data-vscode-navigate-delivered-value="false"');
});
