import { observableWebSocketUrl } from "@agents-in-the-cloud/observable-terminal/client";
import { composerSubmitKey, errorMessage, focusLikelyOpensSoftwareKeyboard, notifyInputListeners, setTextInputValue, type WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { type MicrophoneLease, SharedMicrophone } from "./microphone.ts";

type DictationState = "idle" | "loading" | "recording" | "finishing" | "error";
type AudioCapture = { microphone: MicrophoneLease; context: AudioContext; processor: ScriptProcessorNode; analyser: AnalyserNode };
const dictationEventSchema = Type.Object({
  type: Type.String(),
  status: Type.Optional(Type.Union([Type.Literal("loading"), Type.Literal("error")])),
  message: Type.Optional(Type.String()),
  delta: Type.Optional(Type.String()),
  transcript: Type.Optional(Type.String()),
  error: Type.Optional(Type.Object({ message: Type.String() })),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
});
type DictationEvent = Static<typeof dictationEventSchema>;
const trailingSilenceSeconds = 1;

function composeTranscript(prefix: string, spoken: string, suffix: string) {
  const left = prefix && spoken && !/\s$/.test(prefix) && !/^\s/.test(spoken) ? " " : "";
  const insertion = `${prefix}${left}${spoken}`;
  const right = spoken && suffix && !/\s$/.test(spoken) && !/^[\s,.;:!?)]/.test(suffix) ? " " : "";
  return { text: `${insertion}${right}${suffix}`, caret: insertion.length };
}

export function createDictationComposerController(Controller: WorkspaceClientControllerConstructor, microphoneSource: SharedMicrophone) {
  return class DictationComposerController extends Controller {
    static targets = ["button", "waveform", "status"];
    static values = { workspaceId: String, workspaceTemplateId: String };

    declare readonly workspaceIdValue: string;
    declare readonly workspaceTemplateIdValue: string;
    declare readonly buttonTarget: HTMLButtonElement;
    declare readonly waveformTarget: HTMLCanvasElement;
    declare readonly statusTarget: HTMLElement;

    private get input(): HTMLTextAreaElement {
      return this.element.querySelector("textarea")!;
    }

    private state: DictationState = "idle";
    private socket?: WebSocket;
    private capture?: AudioCapture;
    private waveformFrame?: number;
    private readonly waveformSamples = new Float32Array(256);
    private waveformColor = "";
    private prefix = "";
    private suffix = "";
    private committed = "";
    private partial = "";
    private submitPending = false;
    private pendingSubmitter?: HTMLButtonElement | HTMLInputElement;

    connect(): void {
      window.addEventListener("keydown", this.keydown);
    }

    disconnect(): void {
      window.removeEventListener("keydown", this.keydown);
      this.closeSession();
      this.submitPending = false;
      this.pendingSubmitter = undefined;
      this.setState("idle", "Dictate");
    }

    private readonly keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !composerSubmitKey(event)) return;
      if (this.state === "idle" || this.state === "error") return;
      const target = event.target instanceof Element ? event.target : null;
      const otherEditor = target?.closest("input, textarea, select, [contenteditable='true']");
      if (otherEditor && !this.element.contains(otherEditor)) return;
      event.preventDefault();
      const form = this.element.querySelector<HTMLFormElement>("form")!;
      const submitter = form.querySelector<HTMLButtonElement | HTMLInputElement>('button[type="submit"], button:not([type]), input[type="submit"]');
      form.requestSubmit(submitter ?? undefined);
    };

    submit(event: SubmitEvent): void {
      if (this.state === "idle" || this.state === "error") return;
      if (this.state === "loading" && this.input.value.trim()) {
        this.closeSession();
        this.setState("idle", "Dictate");
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.submitPending = true;
      this.pendingSubmitter = event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement
        ? event.submitter
        : undefined;
      if (this.state === "recording") this.finish();
      else if (this.state === "loading") this.setState("finishing", "Finishing…");
    }

    toggle(): void {
      if (this.state === "recording") {
        this.finish();
        return;
      }
      if (this.state === "loading") {
        this.closeSession();
        this.setState("idle", "Dictate");
        this.focusAfterDictation();
        return;
      }
      if (this.state === "finishing") return;
      this.start();
    }

    private start(): void {
      const selectionStart = this.input.selectionStart;
      const selectionEnd = this.input.selectionEnd;
      this.prefix = this.input.value.slice(0, selectionStart);
      this.suffix = this.input.value.slice(selectionEnd);
      this.committed = "";
      this.partial = "";
      this.setState("loading", "Preparing dictation model…");
      this.input.blur();
      this.setProgress(0);
      const query = this.workspaceIdValue ? `?workspaceId=${encodeURIComponent(this.workspaceIdValue)}`
        : this.workspaceTemplateIdValue ? `?workspaceTemplateId=${encodeURIComponent(this.workspaceTemplateIdValue)}` : "";
      const socket = new WebSocket(observableWebSocketUrl(`/dictation/realtime${query}`));
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        if (this.socket !== socket) return;
        this.received(Value.Parse(dictationEventSchema, JSON.parse(String(event.data))));
      });
      socket.addEventListener("error", () => {
        if (this.socket === socket) this.fail("Could not connect to dictation");
      });
      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        this.closeSession();
        this.setState("idle", "Dictate");
      });
    }

    private received(event: DictationEvent): void {
      if (event.type === "agents-in-the-cloud.dictation.status") {
        if (event.status === "loading") {
          this.setState("loading", event.message ?? "Preparing dictation model…");
          this.setProgress(event.progress ?? 0);
        }
        else if (event.status === "error") this.fail(event.message ?? "Dictation failed");
        return;
      }
      if (event.type === "session.created") {
        if (this.state === "finishing") this.commitAudio();
        else void this.startCapture();
      } else if (event.type.endsWith(".delta")) {
        this.partial += event.delta ?? "";
        this.renderTranscript();
      } else if (event.type.endsWith(".completed")) {
        const transcript = event.transcript ?? this.partial;
        const segment = `${this.committed && transcript ? " " : ""}${transcript}`;
        this.committed += segment;
        this.partial = "";
        this.renderTranscript();
        if (this.state === "finishing") this.dictationFinished();
      } else if (event.type === "error") {
        this.fail(event.error?.message ?? "Dictation failed");
      }
    }

    private async startCapture(): Promise<void> {
      const socket = this.socket;
      try {
        const microphone = await microphoneSource.acquire();
        if (this.socket !== socket || socket?.readyState !== WebSocket.OPEN) {
          microphone.release();
          return;
        }
        if (this.state === "finishing") {
          microphone.release();
          this.commitAudio();
          return;
        }
        const context = new AudioContext();
        const source = context.createMediaStreamSource(microphone.stream);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const analyser = context.createAnalyser();
        const sink = context.createGain();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        sink.gain.value = 0;
        processor.onaudioprocess = (audioEvent) => {
          if (this.socket?.readyState !== WebSocket.OPEN || this.state !== "recording") return;
          const samples = audioEvent.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(samples.length);
          for (let index = 0; index < samples.length; index += 1) {
            pcm[index] = Math.max(-32768, Math.min(32767, Math.round((samples[index] ?? 0) * 32767)));
          }
          this.socket.send(pcm.buffer);
        };
        source.connect(analyser);
        analyser.connect(processor);
        processor.connect(sink);
        sink.connect(context.destination);
        this.capture = { microphone, context, processor, analyser };
        this.socket?.send(JSON.stringify({
          type: "session.update",
          session: { sample_rate: context.sampleRate, language: "auto", automatic_punctuation: true },
        }));
        this.setState("recording", "Listening…");
        this.animateWaveform();
      } catch (error) {
        if (this.socket === socket) this.fail(errorMessage(error));
      }
    }

    private finish(): void {
      this.setState("finishing", "Finishing…");
      const { sampleRate } = this.capture!.context;
      this.stopCapture();
      if (this.socket?.readyState !== WebSocket.OPEN) {
        this.socket?.close();
        return;
      }
      this.socket.send(new Int16Array(Math.round(sampleRate * trailingSilenceSeconds)).buffer);
      this.commitAudio();
    }

    private commitAudio(): void {
      this.socket!.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }

    private dictationFinished(): void {
      this.closeSession();
      this.setState("idle", "Dictate");
      if (!this.submitPending) {
        this.focusAfterDictation();
        return;
      }
      this.submitPending = false;
      const submitter = this.pendingSubmitter;
      this.pendingSubmitter = undefined;
      if (submitter) submitter.form!.requestSubmit(submitter);
      else this.element.querySelector<HTMLFormElement>("form")!.requestSubmit();
    }

    private focusAfterDictation(): void {
      if (focusLikelyOpensSoftwareKeyboard()) return;
      this.input.focus({ preventScroll: true });
      const { caret } = this.transcript();
      this.input.setSelectionRange(caret, caret);
    }

    private transcript() {
      return composeTranscript(this.prefix, `${this.committed}${this.partial}`, this.suffix);
    }

    private stopCapture(): void {
      if (this.waveformFrame !== undefined) cancelAnimationFrame(this.waveformFrame);
      this.capture?.microphone.release();
      if (this.capture) {
        this.capture.processor.onaudioprocess = null;
        if (this.capture.context.state !== "closed") void this.capture.context.close();
      }
      this.capture = undefined;
      this.waveformFrame = undefined;
      this.waveformColor = "";
      this.waveformTarget.getContext("2d")?.clearRect(0, 0, this.waveformTarget.width, this.waveformTarget.height);
    }

    private renderTranscript(): void {
      setTextInputValue(this.input, this.transcript().text);
      this.input.scrollTop = this.input.scrollHeight;
    }

    private animateWaveform(): void {
      if (!this.capture || this.state !== "recording") return;
      this.capture.analyser.getFloatTimeDomainData(this.waveformSamples);
      this.drawWaveform(this.waveformSamples);
      this.waveformFrame = requestAnimationFrame(() => this.animateWaveform());
    }

    private drawWaveform(samples: Float32Array): void {
      const canvas = this.waveformTarget;
      const ratio = window.devicePixelRatio || 1;
      const width = 24;
      const height = 22;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }
      const drawing = canvas.getContext("2d")!;
      drawing.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawing.clearRect(0, 0, width, height);
      this.waveformColor ||= getComputedStyle(canvas).color;
      drawing.fillStyle = this.waveformColor;
      const bars = 5;
      const stride = Math.max(1, Math.floor(samples.length / bars));
      for (let bar = 0; bar < bars; bar += 1) {
        let peak = 0;
        for (let index = bar * stride; index < Math.min(samples.length, (bar + 1) * stride); index += 1) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
        const barHeight = Math.max(2, Math.min(height, peak * height * 3.2));
        drawing.fillRect(bar * 5, (height - barHeight) / 2, 3, barHeight);
      }
    }

    private updateButtonDisabled(): void {
      this.buttonTarget.disabled = this.state === "finishing";
    }

    private closeSession(): void {
      this.stopCapture();
      this.socket?.close();
      this.socket = undefined;
    }

    private fail(message: string): void {
      this.closeSession();
      this.submitPending = false;
      this.pendingSubmitter = undefined;
      this.setState("error", message);
    }

    private setProgress(progress: number): void {
      this.buttonTarget.style.setProperty("--button-progress", String(progress));
    }

    private setState(state: DictationState, label: string): void {
      const working = state === "loading" || state === "finishing";
      this.state = state;
      this.buttonTarget.dataset.state = state;
      this.buttonTarget.dataset.progressState = working ? "in-progress" : "initial";
      this.updateButtonDisabled();
      this.buttonTarget.toggleAttribute("aria-busy", working);
      this.buttonTarget.ariaPressed = state === "recording" || state === "finishing" ? "true" : "false";
      this.buttonTarget.title = label;
      this.buttonTarget.setAttribute("aria-label", label);
      this.statusTarget.textContent = label;
      const dictating = state === "loading" || state === "recording" || state === "finishing";
      const dictationStateChanged = this.element.hasAttribute("data-dictating") !== dictating;
      this.element.toggleAttribute("data-dictating", dictating);
      this.input.readOnly = dictating;
      this.input.inert = dictating;
      if (dictationStateChanged) notifyInputListeners(this.input);
      if (state === "finishing") this.setProgress(100);
      else if (!working) this.setProgress(0);
    }
  };
}
