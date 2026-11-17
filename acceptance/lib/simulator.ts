/**
 * The workspace-owned remote iOS simulator, driven through the ios-serve-sim
 * wrapper (.agents/skills/ios-serve-sim/SKILL.md): taps and rotation through
 * upstream serve-sim, shell commands through the viewer's authenticated /exec,
 * and the page through the Web Inspector (ios_webkit_debug_proxy on the Mac,
 * tunnelled over the existing REMOTEMAC SSH access).
 */
import { samplerSource, type Trace } from "./trace.ts";

const viewer = "http://localhost:4101";

export class Simulator {
  screen = { width: 393, height: 852 };

  private constructor(readonly udid: string, readonly root: string, private readonly token: string, private readonly touches: WebSocket) {}

  static async connect(): Promise<Simulator> {
    // SAFETY: serve-sim's viewer /api contract (see the ios-serve-sim skill).
    const api = await (await fetch(`${viewer}/api`)).json() as { device: string; execToken: string; serveSimBin: string; wsUrl: string };
    const root = api.serveSimBin.replace(/\/npm\/node_modules\/\.bin\/serve-sim$/, "");
    const touches = new WebSocket(api.wsUrl);
    touches.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => { touches.onopen = resolve; touches.onerror = reject; });
    return new Simulator(api.device, root, api.execToken, touches);
  }

  private touch(type: "begin" | "move" | "end", x: number, y: number): void {
    const json = new TextEncoder().encode(JSON.stringify({ type, x: x / this.screen.width, y: y / this.screen.height }));
    const message = new Uint8Array(1 + json.length);
    message[0] = 3;
    message.set(json, 1);
    this.touches.send(message);
  }

  async tap(x: number, y: number): Promise<void> {
    this.touch("begin", x, y);
    await Bun.sleep(40);
    this.touch("end", x, y);
    await Bun.sleep(30);
  }

  async swipe(x: number, fromY: number, toY: number, durationMs = 300): Promise<void> {
    this.touch("begin", x, fromY);
    const steps = 12;
    for (let step = 1; step <= steps; step++) {
      await Bun.sleep(durationMs / steps);
      this.touch("move", x, fromY + (toY - fromY) * step / steps);
    }
    this.touch("end", x, toY);
  }

  async exec(command: string): Promise<string> {
    const response = await fetch(`${viewer}/exec`, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
    // SAFETY: serve-sim's /exec response shape.
    const result = await response.json() as { stdout: string; stderr: string; exitCode: number };
    if (result.exitCode !== 0) throw new Error(`Mac command failed (${result.exitCode}): ${command}\n${result.stderr}`);
    return result.stdout;
  }

  private async serveSim(...args: string[]): Promise<void> {
    const process = Bun.spawn(["bun", "tools/ios-serve-sim/cli.ts", "exec", ...args, "-d", this.udid], { cwd: "/work", stdout: "pipe", stderr: "pipe" });
    if (await process.exited !== 0) throw new Error(`serve-sim ${args.join(" ")} failed: ${await new Response(process.stderr).text()}`);
  }

  async rotate(orientation: "portrait" | "landscape_left"): Promise<void> {
    await this.serveSim("rotate", orientation);
    this.screen = orientation === "portrait" ? { width: 393, height: 852 } : { width: 852, height: 393 };
  }

  close(): void {
    this.touches.close();
  }

  async screenshot(): Promise<Uint8Array> {
    const file = `${this.root}/screenshot.png`;
    const data = await this.exec(`xcrun simctl io ${this.udid} screenshot --type=png ${file} >/dev/null 2>&1 && base64 -i ${file} && rm -f ${file}`);
    return Buffer.from(data, "base64");
  }

  async recordVideo(): Promise<() => Promise<Uint8Array>> {
    const file = `${this.root}/recording.mp4`;
    await this.exec(`rm -f ${file}; (nohup xcrun simctl io ${this.udid} recordVideo --codec=h264 --force ${file} > ${this.root}/recording.log 2>&1 & echo $! > ${this.root}/recording.pid); for i in $(seq 1 50); do grep -q "Recording started" ${this.root}/recording.log && break; sleep 0.1; done`);
    return async () => {
      await this.exec(`kill -INT $(cat ${this.root}/recording.pid); for i in $(seq 1 50); do kill -0 $(cat ${this.root}/recording.pid) 2>/dev/null || break; sleep 0.1; done`);
      const data = await this.exec(`base64 -i ${file} && rm -f ${file}`);
      return Buffer.from(data, "base64");
    };
  }

  /**
   * Starts ios_webkit_debug_proxy for this simulator's inspector socket on the
   * Mac and tunnels its page port here. Returns the local base URL and a stop function.
   */
  async inspector(port = 47_621): Promise<{ url: string; stop(): Promise<void> }> {
    const socket = (await this.exec(`pid=$(pgrep -f "launchd_sim.*${this.udid}" | head -1); sudo lsof -a -p $pid -U 2>/dev/null | grep webinspectord_sim | awk '{print $NF}' | head -1`)).trim();
    if (!socket) throw new Error("Could not find the simulator's Web Inspector socket");
    await this.exec(`[ -f ${this.root}/iwdp.pid ] && kill $(cat ${this.root}/iwdp.pid) 2>/dev/null; (nohup ios_webkit_debug_proxy -s unix:${socket} -c null:${port - 1},:${port} -F > ${this.root}/iwdp.log 2>&1 & echo $! > ${this.root}/iwdp.pid); sleep 1`);
    const tunnel = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-N", "-L", `${port}:127.0.0.1:${port}`, process.env.REMOTEMAC!], { stdout: "ignore", stderr: "pipe" });
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try { await fetch(`${url}/json`); break; } catch (error) {
        if (attempt > 40) throw error;
        await Bun.sleep(250);
      }
    }
    return {
      url,
      stop: async () => {
        tunnel.kill();
        await this.exec(`[ -f ${this.root}/iwdp.pid ] && kill $(cat ${this.root}/iwdp.pid) 2>/dev/null; rm -f ${this.root}/iwdp.pid; true`);
      },
    };
  }
}

interface EvaluateResult { result: { value?: unknown; description?: string }; wasThrown?: boolean }

export class WebKitPage {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: EvaluateResult): void; reject(error: Error): void }>();
  readonly resizes: { url: string; payload: string; t: number }[] = [];
  private readonly sockets = new Map<string, string>();

  private constructor(private readonly socket: WebSocket, private target: string) {
    socket.addEventListener("message", (event) => {
      // SAFETY: The WebKit inspector protocol sends JSON messages.
      const message = JSON.parse(String(event.data)) as { method?: string; params?: { targetInfo?: { targetId: string }; message?: string } };
      if (message.method === "Target.targetCreated" && message.params?.targetInfo) this.target = message.params.targetInfo.targetId;
      if (message.method !== "Target.dispatchMessageFromTarget" || !message.params?.message) return;
      // SAFETY: Target messages are JSON protocol messages.
      const inner = JSON.parse(message.params.message) as { id?: number; result?: EvaluateResult; error?: { message: string }; method?: string; params?: { requestId: string; url?: string; response?: { payloadData: string } } };
      if (inner.method === "Network.webSocketCreated" && inner.params?.url) this.sockets.set(inner.params.requestId, inner.params.url);
      if (inner.method === "Network.webSocketFrameSent" && inner.params?.response?.payloadData.includes('"type":"resize"')) {
        this.resizes.push({ url: this.sockets.get(inner.params.requestId) ?? "", payload: inner.params.response.payloadData, t: Date.now() });
      }
      if (inner.id !== undefined) {
        const waiter = this.pending.get(inner.id);
        this.pending.delete(inner.id);
        if (inner.error) waiter?.reject(new Error(inner.error.message));
        else waiter?.resolve(inner.result!);
      }
    });
  }

  static async open(inspectorUrl: string, choose: (page: { url: string; appId: string }) => boolean): Promise<WebKitPage> {
    // SAFETY: ios_webkit_debug_proxy's /json page listing.
    const pages = await (await fetch(`${inspectorUrl}/json`)).json() as { url: string; appId: string; webSocketDebuggerUrl: string }[];
    const page = pages.find(choose);
    if (!page) throw new Error(`No matching inspectable page among ${pages.map((item) => `${item.appId} ${item.url}`).join(", ")}`);
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const result = new WebKitPage(socket, "");
    for (let attempt = 0; !result.target; attempt++) {
      if (attempt > 40) throw new Error("The page did not announce its inspector target");
      await Bun.sleep(50);
    }
    return result;
  }

  async enableNetwork(): Promise<void> {
    await this.send("Network.enable", {});
  }

  private send(method: "Runtime.evaluate" | "Network.enable", params: { expression: string; returnByValue: boolean } | Record<string, never>): Promise<EvaluateResult> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: this.target, message: JSON.stringify({ id, method, params }) } }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.wasThrown) throw new Error(`evaluate failed: ${result.result.description}\n${expression.slice(0, 200)}`);
    // SAFETY: Callers state the shape their expression returns.
    return result.result.value as T;
  }

  async startTrace(): Promise<void> {
    await this.evaluate<string>(samplerSource);
    await Bun.sleep(120);
  }

  async mark(label: string): Promise<number> {
    await this.evaluate<boolean>(`window.__acceptance.mark(${JSON.stringify(label)})`);
    return this.evaluate<number>("window.__acceptance.marks[window.__acceptance.marks.length - 1].t");
  }

  async takeTrace(): Promise<Trace> {
    // SAFETY: The sampler serializes frames and marks as JSON.
    return JSON.parse(await this.evaluate<string>("window.__acceptance.take()")) as Trace;
  }

  close(): void {
    this.socket.close();
  }
}
