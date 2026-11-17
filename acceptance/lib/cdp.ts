import { chromium, type Browser, type CDPSession } from "@playwright/test";
import { samplerSource, type Trace } from "./trace.ts";

export class ChromePage {
  readonly resizes: { url: string; payload: string; t: number }[] = [];
  private readonly sockets = new Map<string, string>();

  private constructor(private readonly browser: Browser, readonly cdp: CDPSession, private readonly close_: () => Promise<void>) {
    cdp.on("Network.webSocketCreated", ({ requestId, url }) => this.sockets.set(requestId, url));
    cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
      if (response.payloadData.includes('"type":"resize"')) this.resizes.push({ url: this.sockets.get(requestId) ?? "", payload: response.payloadData, t: Date.now() });
    });
  }

  static async open(cdpUrl: string): Promise<ChromePage> {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0]!;
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return new ChromePage(browser, cdp, async () => { await page.close(); await browser.close(); });
  }

  async layout(kind: "mobile" | "desktop"): Promise<void> {
    if (kind === "mobile") {
      await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
      await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    } else {
      await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    }
    this.mobile = kind === "mobile";
  }

  private mobile = false;

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    // SAFETY: Callers state the shape their expression returns.
    return result.result.value as T;
  }

  async navigate(url: string, ready: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url });
    await this.waitFor(ready, 30_000);
    await Bun.sleep(800);
  }

  async waitFor(selector: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!await this.evaluate<boolean>(`[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.checkVisibility())`)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${selector}`);
      await Bun.sleep(150);
    }
  }

  async visible(selector: string): Promise<boolean> {
    return this.evaluate<boolean>(`[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.checkVisibility())`);
  }

  async center(selector: string): Promise<{ x: number; y: number }> {
    const point = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.checkVisibility());
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!point) throw new Error(`No visible element for ${selector}`);
    return point;
  }

  async tap(selector: string, offset: { x?: number; y?: number } = {}): Promise<void> {
    const point = await this.center(selector);
    await this.tapAt(point.x + (offset.x ?? 0), point.y + (offset.y ?? 0));
  }

  async tapAt(x: number, y: number): Promise<void> {
    if (this.mobile) {
      await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
  }

  async press(selector: string): Promise<() => Promise<void>> {
    const { x, y } = await this.center(selector);
    if (this.mobile) {
      await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      return async () => { await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
    }
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    return async () => { await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); };
  }

  async wheel(selector: string, deltaY: number): Promise<void> {
    const { x, y } = await this.center(selector);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  }

  async insertText(text: string): Promise<void> {
    await this.cdp.send("Input.insertText", { text });
  }

  async key(key: "Enter" | "Backspace" | "a", modifiers: { meta?: boolean; ctrl?: boolean } = {}): Promise<void> {
    const codes = { Enter: 13, Backspace: 8, a: 65 } as const;
    const flags = (modifiers.meta ? 4 : 0) | (modifiers.ctrl ? 2 : 0);
    const text = key === "Enter" && !flags ? "\r" : key === "a" && !flags ? "a" : undefined;
    const base = { key, code: key === "a" ? "KeyA" : key, windowsVirtualKeyCode: codes[key], modifiers: flags };
    await this.cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async screenshot(): Promise<Uint8Array> {
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(data, "base64");
  }

  async fakeMicrophone(): Promise<void> {
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.05;
      const destination = context.createMediaStreamDestination();
      tone.connect(gain).connect(destination);
      tone.start();
      return destination.stream;
    };` });
  }

  async startTrace(): Promise<void> {
    await this.evaluate<string>(samplerSource);
    await Bun.sleep(120);
  }

  async mark(label: string): Promise<number> {
    await this.evaluate<boolean>(`window.__acceptance.mark(${JSON.stringify(label)})`);
    return this.evaluate<number>("window.__acceptance.marks.at(-1).t");
  }

  async takeTrace(): Promise<Trace> {
    // SAFETY: The sampler serializes frames and marks as JSON.
    return JSON.parse(await this.evaluate<string>("window.__acceptance.take()")) as Trace;
  }

  async close(): Promise<void> {
    await this.close_();
  }
}
