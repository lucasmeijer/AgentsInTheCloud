import { expect, test } from "bun:test";
import { once } from "node:events";
import net from "node:net";
import { Duplex } from "node:stream";
import { bridgeWebSocket, requestWebSocketUpgrade } from "../src/egress/websocket.ts";

// Exercise the actual request factory and HttpsProxyAgent on Bun. The proxy accepts
// the connection but never answers CONNECT (or completes TLS for an HTTPS proxy).
async function stalledProxy(protocol: "http" | "https", exercise: (fixture: {
  client: Duplex;
  result: Promise<Error | undefined>;
  connected: Promise<void>;
  closed: Promise<void>;
  received: () => string;
}) => Promise<void>) {
  let incoming = "";
  const sockets = new Set<net.Socket>();
  let reportConnected!: () => void;
  let reportClosed!: () => void;
  const connected = new Promise<void>(resolve => { reportConnected = resolve; });
  const closed = new Promise<void>(resolve => { reportClosed = resolve; });
  const proxy = net.createServer(socket => {
    sockets.add(socket);
    socket.on("data", chunk => { incoming += chunk.toString(); reportConnected(); });
    socket.once("close", () => { sockets.delete(socket); reportClosed(); });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  // SAFETY: The listener is bound to a TCP address.
  const port = (proxy.address() as net.AddressInfo).port;
  const oldProxy = process.env.https_proxy;
  const oldNoProxy = process.env.no_proxy;
  process.env.https_proxy = `${protocol}://127.0.0.1:${port}`;
  process.env.no_proxy = "localhost";
  const client = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const request = new Request("https://websocket.example.test/socket", { headers: {
    connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  } });
  const result = bridgeWebSocket(request, client, Buffer.alloc(0), requestWebSocketUpgrade, value => value).then(() => undefined, (error: Error) => error);
  try {
    await exercise({ client, result, connected, closed, received: () => incoming });
  } finally {
    client.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    if (oldProxy === undefined) delete process.env.https_proxy; else process.env.https_proxy = oldProxy;
    if (oldNoProxy === undefined) delete process.env.no_proxy; else process.env.no_proxy = oldNoProxy;
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Cancellation did not settle/close the pending proxy socket")), milliseconds);
    })]);
  } finally { clearTimeout(timeout!); }
}

test("handshake deadline rejects and closes a stalled CONNECT before the proxy responds", async () => {
  await stalledProxy("http", async ({ client, result, connected, closed, received }) => {
    await within(connected, 2000);
    expect(received()).toStartWith("CONNECT websocket.example.test:443 HTTP/1.1");
    const error = await within(result, 32_000);
    expect(error?.message).toBe("WebSocket upstream handshake timed out");
    await within(closed, 1000);
    expect(client.destroyed).toBe(false);
  });
}, 35_000);

for (const protocol of ["http", "https"] as const) {
  test(`client disconnect cancels the pending ${protocol} proxy socket and settles the handshake`, async () => {
    await stalledProxy(protocol, async ({ client, result, connected, closed }) => {
      await within(connected, 2000);
      client.destroy();
      const error = await within(result, 1000);
      expect(error?.message).toBe("WebSocket client disconnected during handshake");
      await within(closed, 1000);
    });
  });
}
