/** CSRF protection, not authentication: non-browser clients can forge Origin.
 * Host identity comes from the request URL, not forwarded/public-origin metadata.
 * Parent ingress translates legitimate same-origin requests to the local origin
 * and preserves a denial for foreign origins coinciding with that local address. */
export function managementOriginRejection(request: Request, peerAddress?: string): Response | undefined {
  const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (!websocket && ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;

  const target = new URL(request.url);
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  if (isLoopbackPeer(peerAddress) && forwardedProtocol !== null) {
    if (forwardedProtocol !== "http" && forwardedProtocol !== "https") return forbiddenOrigin();
    target.protocol = `${forwardedProtocol}:`;
  }
  const origin = request.headers.get("origin");
  const parentDenied = request.headers.get("x-agents-in-the-cloud-origin-context") === "null";
  if (origin === target.origin && !parentDenied) return;
  return forbiddenOrigin();
}

function forbiddenOrigin(): Response {
  return new Response("Forbidden management origin", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function isLoopbackPeer(address: string | undefined): boolean {
  return address === "::1" || /^(?:127\.|::ffff:127\.)/.test(address ?? "");
}
