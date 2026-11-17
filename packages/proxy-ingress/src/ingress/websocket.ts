function isForwardableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    || (code >= 3000 && code <= 4999);
}

export function closeWebSocket(socket: Pick<WebSocket, "close">, code: number, reason: string): void {
  if (isForwardableCloseCode(code)) socket.close(code, reason);
  else socket.close();
}

export const maxSocketBufferedBytes = 8 * 1024 * 1024;

export function forwardToUpstream(
  upstream: Pick<WebSocket, "bufferedAmount" | "send" | "close">,
  downstream: Pick<WebSocket, "close">,
  payload: string | ArrayBuffer,
): void {
  const bytes = payload instanceof ArrayBuffer ? payload.byteLength : Buffer.byteLength(payload);
  if (upstream.bufferedAmount + bytes > maxSocketBufferedBytes) {
    const reason = "Workspace stream consumer is too slow";
    upstream.close(1013, reason);
    downstream.close(1013, reason);
    return;
  }
  upstream.send(payload);
}
