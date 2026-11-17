import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, isNotFoundError } from "@agents-in-the-cloud/core";
import { errorMessage, type WorkspaceServerSocketHandler, type WorkspaceSocketConnection } from "@agents-in-the-cloud/shared";
import { stat } from "node:fs/promises";
import { workspaceWorkHostPath } from "@agents-in-the-cloud/workspace";
import { cachedWorkspaceTemplateSourcePath } from "@agents-in-the-cloud/workspace-templates";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { readDictationModel, dictationModel, type DictationModelId } from "./models.ts";
import { captureProcessStderr, processExitMessage } from "./process-diagnostics.ts";
import { addTranscriptionContext, readDictationContext } from "./dictation-context.ts";
import { ensureTranscriptionRuntime } from "./runtime.ts";
import { spawnTranscriptionProcess } from "./process.ts";

const transcriptionPort = 8098;
const transcriptionReadyUrl = `http://127.0.0.1:${transcriptionPort}/ready`;
const transcriptionSocketUrl = `ws://127.0.0.1:${transcriptionPort}/v1/realtime`;
let transcriptionServer: Promise<void> | undefined;
let transcriptionProcess: ReturnType<typeof Bun.spawn> | undefined;

async function isTranscriptionServerReady(): Promise<boolean> {
  try {
    return (await fetch(transcriptionReadyUrl)).ok;
  } catch {
    return false;
  }
}

function transcriptionCacheDir(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "transcription-cache");
}

async function artifactProgress(modelId: DictationModelId): Promise<number> {
  const { artifact } = dictationModel(modelId);
  const path = join(transcriptionCacheDir(), "nemo-speech", "models", artifact.repository, artifact.revision, artifact.filename);
  const size = await stat(path).then((file) => file.size).catch(async (error) => {
    if (!isNotFoundError(error)) throw error;
    return await stat(`${path}.partial`).then((file) => file.size).catch((partialError) => {
      if (isNotFoundError(partialError)) return 0;
      throw partialError;
    });
  });
  return Math.min(100, Math.floor(size / artifact.size * 100));
}

async function startTranscriptionServer(model: DictationModelId): Promise<void> {
  if (await isTranscriptionServerReady()) return;

  const cacheDir = transcriptionCacheDir();
  const executable = await ensureTranscriptionRuntime(cacheDir);
  const child = spawnTranscriptionProcess([
    executable,
    "serve",
    "--host", "127.0.0.1",
    "--port", String(transcriptionPort),
    "--threads", String(Math.max(2, Math.min(8, availableParallelism()))),
    "--asr-model", model,
    "--device", "cpu",
    "--no-ui",
  ], cacheDir);
  transcriptionProcess = child;
  const stderr = captureProcessStderr(child.stderr);

  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (await isTranscriptionServerReady()) return;
    if (child.exitCode !== null) throw new Error(processExitMessage("NeMo Speech", child.exitCode, await stderr));
    await Bun.sleep(500);
  }
  child.kill();
  throw new Error("NeMo Speech did not become ready within ten minutes");
}

export async function stopTranscriptionServer(): Promise<void> {
  const process = transcriptionProcess;
  transcriptionProcess = undefined;
  transcriptionServer = undefined;
  if (!process || process.exitCode !== null) return;
  process.kill();
  await process.exited;
}

function ensureTranscriptionServer(model: DictationModelId): Promise<void> {
  transcriptionServer ??= startTranscriptionServer(model).catch((error) => {
    transcriptionServer = undefined;
    throw error;
  });
  return transcriptionServer;
}

function status(socket: WorkspaceSocketConnection, state: "loading" | "error", message: string, progress?: number): void {
  socket.send(JSON.stringify({ type: "agents-in-the-cloud.dictation.status", status: state, message, progress }));
}

export const createDictationSocketSession: WorkspaceServerSocketHandler = (url) => {
  if (url.pathname !== "/dictation/realtime") return undefined;

  let browser: WorkspaceSocketConnection | undefined;
  let upstream: WebSocket | undefined;
  let phrases: string[] = [];

  async function connect(): Promise<void> {
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const modelId = await readDictationModel();
      const workspaceId = url.searchParams.get("workspaceId");
      const workspaceTemplateId = url.searchParams.get("workspaceTemplateId");
      const source = workspaceId ? workspaceWorkHostPath(workspaceId)
        : workspaceTemplateId ? await cachedWorkspaceTemplateSourcePath(workspaceTemplateId) : undefined;
      phrases = source ? await readDictationContext(source) : [];
      const model = dictationModel(modelId);
      let reportedProgress = -1;
      const reportProgress = async () => {
        if (!browser) return;
        const progress = await artifactProgress(modelId);
        if (progress === reportedProgress) return;
        reportedProgress = progress;
        const message = progress < 100 ? `Downloading ${model.name} · ${progress}%` : `Loading ${model.name}…`;
        status(browser, "loading", message, progress);
      };
      if (browser) status(browser, "loading", "Preparing the CPU dictation runtime…", 0);
      await ensureTranscriptionRuntime(transcriptionCacheDir());
      if (!browser) return;
      await reportProgress();
      progressTimer = setInterval(() => void reportProgress(), 250);
      await ensureTranscriptionServer(modelId);
      if (!browser) return;
      upstream = new WebSocket(transcriptionSocketUrl);
      upstream.addEventListener("message", (event) => browser?.send(String(event.data)));
      upstream.addEventListener("error", () => {
        if (browser) status(browser, "error", "The dictation service disconnected");
      });
      upstream.addEventListener("close", () => browser?.close());
    } catch (error) {
      if (!browser) return;
      status(browser, "error", errorMessage(error));
      browser.close(1011, "dictation service unavailable");
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  return {
    open(socket) {
      browser = socket;
      status(socket, "loading", "Preparing the CPU dictation model…", 0);
      void connect();
    },
    message(_socket, message) {
      if (upstream?.readyState !== WebSocket.OPEN) throw new Error("Audio arrived before the transcription server was ready");
      upstream.send(message instanceof Uint8Array ? new Uint8Array(message).buffer : addTranscriptionContext(message, phrases));
    },
    close() {
      upstream?.close();
      browser = undefined;
    },
  };
};
