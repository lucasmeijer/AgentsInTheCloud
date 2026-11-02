import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { buildGoProgram } from "@agents-in-the-cloud/core";
import { closeWorkspaceHelperConnection, workspaceHelperSocketPath } from "@agents-in-the-cloud/workspace";
import { createDurableFileTools, workspaceImages } from "../../src/server/durable-tools.ts";
import { WorkspaceFileSystem, workspaceAbsolutePath } from "../../src/server/durable-workspace-files.ts";
import { openDurableWorkspace, type DurableWorkspace } from "../../src/server/durable-workspace.ts";
import { projectDurableTranscript } from "../../src/server/durable-transcript.ts";
import type { TranscriptItem } from "@agents-in-the-cloud/agent/server/transcript";

// A real helper, running as root and reaching files as the agent's user, as in a workspace.
const workspaceId = "files-test";
const context = BACKGROUND_CONTEXT;
let directory: string;
let helper: Bun.Subprocess<"ignore", "inherit", "pipe">;
const workspaces: DurableWorkspace[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "workspace-files-"));
  const binary = join(directory, "aitc-workspace-helper");
  await buildGoProgram(fileURLToPath(new URL("../../../workspace-helper/helper", import.meta.url)), binary, `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`);
  const socket = workspaceHelperSocketPath(workspaceId);
  // The helper gives its socket to this folder's owner.
  await mkdir(dirname(socket), { recursive: true });
  helper = Bun.spawn(["sudo", "-n", binary, "--listen", socket, "--state", join(directory, "state")], { stdout: "inherit", stderr: "pipe" });
  const stderr = helper.stderr.pipeThrough(new TextDecoderStream()).getReader();
  let log = "";
  while (!log.includes("listening on")) {
    const { done, value } = await stderr.read();
    if (done) throw new Error(`The helper did not start: ${log}`);
    log += value;
  }
  void (async () => { while (!(await stderr.read()).done); })();
}, 120_000);

afterEach(async () => { await Promise.all(workspaces.splice(0).map((workspace) => workspace.close())); });

afterAll(async () => {
  closeWorkspaceHelperConnection(workspaceId);
  helper.kill();
  await helper.exited;
  // The helper keeps its state as root.
  await Bun.spawn(["sudo", "-n", "rm", "-rf", directory]).exited;
});

async function files() {
  const path = await mkdtemp(join(directory, "files-"));
  return { path, env: new WorkspaceFileSystem(workspaceId), tools: createDurableFileTools(new WorkspaceFileSystem(workspaceId), workspaceImages) };
}

/** Runs one call of `tool` through a Harness, as the agent would, and returns its result message. */
async function call(tool: ToolRegistration<any>, args: Record<string, JsonValue>) {
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall(tool.name, args)], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "workspace-files", tools: [tool] }));
  const workspace = await openDurableWorkspace(await mkdtemp(join(directory, "journal-")), "files-test", { models, registry });
  workspaces.push(workspace);
  const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Files" }, { model: { provider: "faux", modelId: "faux-1" } });
  const submission = await conversation.submit({ type: "input", content: "Use the tool", requestId: "request" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  const messages = (await conversation.entries({}, 100, undefined, context)).items.flatMap((entry) => entry.model ?? []);
  const result = messages.find((message) => message.role === "toolResult");
  if (result?.role !== "toolResult") throw new Error("The tool left no result");
  const watch = await conversation.watch(context);
  const tools = (items: TranscriptItem[]): TranscriptItem[] => items.flatMap((item) => item.type === "tool" ? [item] : item.type === "working" ? tools(item.items) : []);
  const [shown] = tools(projectDurableTranscript(watch.value));
  await watch.stop();
  return {
    ...result,
    text: result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
    transcriptText: shown?.type === "tool" ? shown.tool.resultText : undefined,
  };
}

test("paths resolve in the workspace: relative to /work, ~ to the agent's home", () => {
  expect(workspaceAbsolutePath("foo.ts")).toBe("/work/foo.ts");
  expect(workspaceAbsolutePath("nested/../foo.ts")).toBe("/work/foo.ts");
  expect(workspaceAbsolutePath("../foo.ts")).toBe("/foo.ts");
  expect(workspaceAbsolutePath("/etc/passwd")).toBe("/etc/passwd");
  expect(workspaceAbsolutePath("~")).toBe("/home/agents-in-the-cloud");
  expect(workspaceAbsolutePath("~/notes.md")).toBe("/home/agents-in-the-cloud/notes.md");
  expect(workspaceAbsolutePath("file:///work/a%20b.md")).toBe("/work/a b.md");
});

test("write creates folders, edit keeps a byte-order mark and line endings, read pages with offset and limit", async () => {
  const { path, tools: [read, write, edit] } = await files();
  const file = join(path, "nested/folder/example.txt");
  expect((await call(write!, { path: file, content: "\uFEFFfirst\r\nsecond\r\nthird\r\n" })).isError).toBe(false);
  const edited = await call(edit!, { path: file, edits: [{ oldText: "second", newText: "changed" }] });
  expect(edited.isError).toBe(false);
  expect(await readFile(file, "utf8")).toBe("\uFEFFfirst\r\nchanged\r\nthird\r\n");
  const shown = await call(read!, { path: file, offset: 2, limit: 1 });
  expect(shown.text).toStartWith("changed");
  expect(shown.text).toContain("2 more lines in file. Use offset=3 to continue.");
  // People read the Harness's remark without the markup the model gets it in.
  expect(shown.transcriptText).toBe("changed\r\n\n2 more lines in file. Use offset=3 to continue.");
});

test("read takes large files a part at a time and says where to continue", async () => {
  const { path, tools: [read] } = await files();
  const file = join(path, "large.log");
  await writeFile(file, Array.from({ length: 300_000 }, (_, index) => `line ${index + 1}`).join("\n"));
  const shown = await call(read!, { path: file, offset: 150_000 });
  expect(shown.text).toStartWith("line 150000\nline 150001");
  expect(shown.text).toContain("Showing lines 150000-151999 of 300000. Use offset=152000 to continue.");
});

test("images are read for the model", async () => {
  const { path, tools: [read] } = await files();
  const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
  await writeFile(join(path, "red.png"), Buffer.from(png, "base64"));
  const shown = await call(read!, { path: join(path, "red.png") });
  expect(shown.isError).toBe(false);
  expect(shown.content).toContainEqual({ type: "image", mimeType: "image/png", data: png });
});

test("missing files, folders and failed edits are errors the agent can read", async () => {
  const { path, tools: [read, , edit] } = await files();
  expect((await call(read!, { path: join(path, "missing.txt") })).text).toContain("no such file or directory");
  await mkdir(join(path, "folder"));
  expect((await call(read!, { path: join(path, "folder") })).text).toContain("EISDIR");
  expect((await call(edit!, { path: join(path, "folder"), edits: [{ oldText: "a", newText: "b" }] })).text).toContain("Path is not a file");
  await writeFile(join(path, "same.txt"), "same\nsame\n");
  expect((await call(edit!, { path: join(path, "same.txt"), edits: [{ oldText: "same", newText: "other" }] })).isError).toBe(true);
  expect(await readFile(join(path, "same.txt"), "utf8")).toBe("same\nsame\n");
});

test("the environment describes files as the Node environment would", async () => {
  const { path, env } = await files();
  await writeFile(join(path, "file.txt"), "hello");
  await symlink(join(path, "file.txt"), join(path, "link.txt"));
  expect(await env.exists(join(path, "file.txt"), context)).toEqual({ ok: true, value: true });
  expect(await env.exists(join(path, "missing.txt"), context)).toEqual({ ok: true, value: false });
  expect(await env.fileInfo(join(path, "link.txt"), context)).toMatchObject({ ok: true, value: { kind: "symlink", size: 5 } });
  expect(await env.fileInfo(path, context)).toMatchObject({ ok: true, value: { kind: "directory" } });
  expect(await env.canonicalPath(join(path, "link.txt"), context)).toEqual({ ok: true, value: await realpath(join(path, "file.txt")) });
  expect(await env.canonicalPath(join(path, "missing.txt"), context)).toMatchObject({ ok: false, error: { code: "not_found" } });
  const temporary = await env.createTempDir("files-test-", context);
  if (!temporary.ok) throw temporary.error;
  expect(temporary.value).toStartWith("/tmp/files-test-");
  await rm(temporary.value, { recursive: true });
});
