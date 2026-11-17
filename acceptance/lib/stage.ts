/**
 * Stages the shared acceptance setup through Atelier's automation API
 * (docs/automation.md): a built-in agent with a long transcript, a Pi CLI
 * agent and a terminal tab. The built-in agent also writes a prompt template with a
 * composer button, as a user's agent would. An existing workspace can be reused.
 */

export interface Stage {
  atelier: string;
  workspaceId: string;
  builtinId: string;
  piId: string;
  terminalKey: string;
}

interface WorkspaceJson {
  workspace: {
    id: string;
    phase: { kind: string; status?: string };
    agents: { id: string; agentTypeId: string; busy: boolean; title: string }[];
    workViews: { key: string; reference: { type: string } }[];
  };
}

async function json<T>(atelier: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(new URL(path, atelier), {
    method: init.method ?? "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json", Origin: new URL(atelier).origin },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${text.slice(0, 400)}`);
  // SAFETY: Atelier's documented JSON contract for these operations (GET /openapi.json).
  return JSON.parse(text) as T;
}

const promptTemplate = "---\ndescription: Reply with OK\ncomposer-button: true\n---\nReply with just the word OK.\n";
const longPrompt = `First create the file /work/.agents-in-the-cloud/prompts/ok.md with exactly this content:\n\n${promptTemplate}\nThen, without using any more tools, write a long markdown explanation (about 1500 words, with headings, lists and two short code blocks) of how terminal emulators handle window resizing (SIGWINCH, PTY, tmux).`;

async function workspace(atelier: string, id: string): Promise<WorkspaceJson["workspace"]> {
  return (await json<WorkspaceJson>(atelier, `/workspaces/${encodeURIComponent(id)}`)).workspace;
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(1000);
  }
}

export async function stage(options: { atelier: string; workspaceId?: string; model?: string; log(message: string): void }): Promise<Stage> {
  const { atelier, log } = options;
  let id = options.workspaceId;
  if (!id) {
    log("creating workspace");
    const created = await json<{ workspace: { id: string } }>(atelier, "/workspaces", { method: "POST", body: { source: { type: "empty" }, title: "Composer acceptance", agent: { agentTypeId: "builtin" } } });
    id = created.workspace.id;
  }
  await until("workspace to run", 300_000, async () => {
    const current = await workspace(atelier, id!);
    if (current.phase.status === "failed") throw new Error(`workspace ${id} failed to start`);
    return current.phase.kind === "runningPhase" ? true : undefined;
  });
  let current = await workspace(atelier, id);
  let builtin = current.agents.find((agent) => agent.agentTypeId === "builtin");
  if (!builtin) {
    log("creating built-in agent");
    await json(atelier, `/workspaces/${id}/commands/agent.create.builtin`, { method: "POST", body: {} });
    current = await workspace(atelier, id);
    builtin = current.agents.find((agent) => agent.agentTypeId === "builtin")!;
  }
  const transcript = await fetch(new URL(`/workspaces/${id}?agent=${builtin.id}`, atelier)).then((response) => response.text());
  if (!transcript.includes("SIGWINCH")) {
    log("generating a long transcript");
    if (options.model) await json(atelier, `/workspaces/${id}/agents/${builtin.id}/model`, { method: "POST", body: { model: options.model } });
    await json(atelier, `/workspaces/${id}/agents/${builtin.id}/messages`, { method: "POST", body: { text: longPrompt, mode: "send" } });
    await Bun.sleep(3000);
    await until("the long answer", 300_000, async () => (await workspace(atelier, id!)).agents.find((agent) => agent.id === builtin!.id)!.busy ? undefined : true);
  }
  let pi = current.agents.find((agent) => agent.agentTypeId === "pi");
  if (!pi) {
    log("creating Pi agent");
    const created = await json<{ command: { agentId: string } }>(atelier, `/workspaces/${id}/commands/agent.create.pi`, { method: "POST", body: {} });
    pi = { id: created.command.agentId, agentTypeId: "pi", busy: false, title: "Pi" };
  }
  current = await workspace(atelier, id);
  let terminal = current.workViews.find((view) => view.reference.type === "terminal");
  if (!terminal) {
    log("creating terminal tab");
    await json(atelier, `/workspaces/${id}/commands/terminal.create`, { method: "POST", body: { title: "Shell", cwd: "/work" } });
    terminal = (await workspace(atelier, id)).workViews.find((view) => view.reference.type === "terminal")!;
  }
  return { atelier, workspaceId: id, builtinId: builtin.id, piId: pi.id, terminalKey: terminal.key };
}

export async function tmuxSizes(workspaceId: string): Promise<Record<string, string>> {
  const output = await workspaceExec(workspaceId, ["tmux", "list-windows", "-a", "-F", "#{session_name} #{window_width}x#{window_height}"]);
  return Object.fromEntries(output.trim().split("\n").filter(Boolean).map((line) => {
    const space = line.lastIndexOf(" ");
    return [line.slice(0, space), line.slice(space + 1)];
  }));
}

async function workspaceExec(workspaceId: string, command: string[]): Promise<string> {
  const process = Bun.spawn(["docker", "exec", "-u", "agents-in-the-cloud", `agents-in-the-cloud-${workspaceId}`, ...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  if (await process.exited !== 0) throw new Error(`${command.join(" ")} failed: ${await new Response(process.stderr).text()}`);
  return output;
}
