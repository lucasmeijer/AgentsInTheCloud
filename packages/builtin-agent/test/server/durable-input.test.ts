import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { submitDurableInput } from "../../src/server/durable-input.ts";
import { durableEntryContent } from "../../src/server/durable-images.ts";
import { openDurableWorkspace, type DurableWorkspace } from "../../src/server/durable-workspace.ts";

const context = BACKGROUND_CONTEXT;
const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
const paths: string[] = [];
const workspaces: DurableWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const path = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-durable-images-"));
  paths.push(path);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000, models: [
    { id: "small", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 4, maxHeight: 4 } } } },
    { id: "text", input: ["text"] },
  ] });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const open = async () => {
    const workspace = await openDurableWorkspace(join(path, "journal"), "images-workspace", { models, registry });
    workspaces.push(workspace);
    return workspace;
  };
  return { path, faux, models, open, workspace: await open() };
}
const record = { agentId: "tab", label: "Agent 1", title: "Images" };

test("native input expands skills, sizes attachments per model, and deduplicates after reopen", async () => {
  const { workspace, faux, models, open } = await setup();
  faux.setResponses([fauxAssistantMessage("Done")]);
  const conversation = await workspace.agent(record, { model: { provider: "faux", modelId: "small" } });
  const input = { requestId: "browser-request", text: " /skill:review ", attachmentNotes: ["Attached red.png"], images: [{ type: "image" as const, mimeType: "image/png", data: png }] };
  const expand = async (workspaceId: string, text: string) => {
    expect(workspaceId).toBe("images-workspace");
    expect(text).toBe("/skill:review\n\nAttached red.png");
    return "Expanded skill instructions\nAttached red.png";
  };
  const submission = await submitDurableInput(conversation, "images-workspace", models, input, context, expand);
  expect((await submission.wait(context)).status).toBe("done");
  const entries = (await conversation.entries({}, 100, undefined, context)).items;
  const user = entries.find((entry) => entry.model?.some((message) => message.role === "user"))!;
  const content = durableEntryContent(user);
  expect(content[0]).toEqual({ type: "text", text: "Expanded skill instructions\nAttached red.png" });
  expect(content.find((part) => part.type === "image")?.data).not.toBe(png);
  expect(JSON.stringify(content)).toContain("4x4");
  await workspace.close();
  const reopened = await open();
  const restored = await reopened.agent(record);
  const duplicate = await submitDurableInput(restored, "images-workspace", models, input, context, expand);
  expect(duplicate.id).toBe(submission.id);
  expect((await duplicate.wait(context)).status).toBe("done");
  expect(faux.state.callCount).toBe(1);
  expect((await restored.entries({}, 100, undefined, context)).items).toEqual(entries);
});

test("image-only input retains images and explains non-vision omission", async () => {
  const { workspace, faux, models } = await setup();
  faux.setResponses([fauxAssistantMessage("Done")]);
  const conversation = await workspace.agent(record, { model: { provider: "faux", modelId: "text" } });
  const submission = await submitDurableInput(conversation, "images-workspace", models, {
    requestId: "image-only", text: "", images: [{ type: "image", data: png, mimeType: "image/png" }],
  }, context, async () => { throw new Error("No text to expand"); });
  expect((await submission.wait(context)).status).toBe("done");
  const user = (await conversation.entries({}, 100, undefined, context)).items.find((entry) => entry.model?.some((message) => message.role === "user"))!;
  expect(durableEntryContent(user).find((part) => part.type === "image")?.data).toBe(png);
  expect(JSON.stringify(durableEntryContent(user))).toContain("does not support images");
});

test("invalid admission and preparation failures commit no input or model request", async () => {
  const { workspace, faux, models } = await setup();
  const conversation = await workspace.agent(record, { model: { provider: "faux", modelId: "small" } });
  for (const input of [{ requestId: "", text: "Hello" }, { requestId: "empty", text: "  " }]) {
    await expect(submitDurableInput(conversation, "images-workspace", models, input, context)).rejects.toThrow();
  }
  await expect(submitDurableInput(conversation, "images-workspace", models, { requestId: "skill-failure", text: "/skill:missing" }, context,
    async () => { throw new Error("Skill is unavailable"); })).rejects.toThrow("Skill is unavailable");
  expect((await conversation.entries({}, 100, undefined, context)).items).toHaveLength(0);
  expect(faux.state.callCount).toBe(0);
});
