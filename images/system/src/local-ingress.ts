import { closeWebSocket, forwardToUpstream, maxSocketBufferedBytes } from "../../../packages/proxy-ingress/src/ingress/websocket.ts";

export function localTarget(host: string, appPort: number): number | undefined {
  const hostname = host.split(":")[0];
  if (hostname === "agents-in-the-cloud.localhost") return appPort;
  if (hostname === "system.agents-in-the-cloud.localhost") return 3001;
  const preview = /^p(41\d{3})\.agents-in-the-cloud\.localhost$/.exec(hostname ?? "");
  return preview ? Number(preview[1]) : undefined;
}
export function startLocalIngress(appPort: () => number, listenPort = 3080) {
  return Bun.serve<{ upstream: WebSocket }>({
    hostname: "0.0.0.0", port: listenPort, idleTimeout: 0,
    async fetch(request, server) {
      const port = localTarget(request.headers.get("host") ?? "", appPort());
      if (!port) return new Response("Unknown AgentsInTheCloud endpoint", { status: 404 });
      const url = new URL(request.url);
      const target = `127.0.0.1:${port}${url.pathname}${url.search}`;
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers = new Headers(request.headers);
        const protocols = headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? [];
        for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", "connection", "upgrade"]) headers.delete(name);
        const upstream = new WebSocket(`ws://${target}`, { headers: Object.fromEntries(headers), protocols });
        upstream.binaryType = "arraybuffer";
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { upstream.close(); reject(new Error("AgentsInTheCloud WebSocket timed out")); }, 5000);
            upstream.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
            upstream.addEventListener("error", () => { clearTimeout(timer); reject(new Error("AgentsInTheCloud WebSocket is unavailable")); }, { once: true });
          });
          if (server.upgrade(request, { data: { upstream }, headers: upstream.protocol ? { "sec-websocket-protocol": upstream.protocol } : undefined })) return;
          upstream.close();
        } catch (error) { return new Response(String(error), { status: 502 }); }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      const headers = new Headers(request.headers);
      headers.delete("connection");
      headers.delete("transfer-encoding");
      headers.set("accept-encoding", "identity");
      try {
        const response = await fetch(`http://${target}`, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body, signal: request.signal, redirect: "manual" });
        return response;
      } catch (error) { return new Response(`AgentsInTheCloud endpoint is unavailable: ${String(error)}`, { status: 502 }); }
    },
    websocket: {
      backpressureLimit: maxSocketBufferedBytes, closeOnBackpressureLimit: true,
      open(socket) {
        const upstream = socket.data.upstream;
        upstream.addEventListener("message", event => socket.send(event.data));
        upstream.addEventListener("close", event => closeWebSocket(socket, event.code, event.reason));
        upstream.addEventListener("error", () => socket.close(1011, "AgentsInTheCloud WebSocket failed"));
      },
      message(socket, message) { forwardToUpstream(socket.data.upstream, socket, message instanceof Uint8Array ? new Uint8Array(message).buffer : message); },
      close(socket, code, reason) { closeWebSocket(socket.data.upstream, code, reason); },
    },
  });
}
