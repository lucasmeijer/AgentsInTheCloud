#!/usr/bin/env bun
// Optional dev tool: bun run apps/web/scripts/surface-lighting-tuner.ts <AgentsInTheCloud workspace URL>
// Runs outside the app. The JSON snapshot and lighting-role overrides live beside this file.
import { escapeHtml } from '@agents-in-the-cloud/shared';
import { managementOriginRejection } from '@agents-in-the-cloud/proxy-ingress/server';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import startingSettings from './surface-lighting-tuner/settings.json';

export async function startLightingTuner(destination: string, port = 3100) {
  const workspaceUrl = new URL(destination);
  if (!/^\/workspaces\/[^/]+$/.test(workspaceUrl.pathname)) throw new Error('Pass a workspace URL, not an AgentsInTheCloud settings or home URL.');
  const origin = workspaceUrl.origin;
  const workspaceResponse = await fetch(new URL(workspaceUrl.pathname, origin), { headers: { Accept: 'application/json' } });
  if (!workspaceResponse.ok) throw new Error(`Workspace lookup failed (${workspaceResponse.status}): ${await workspaceResponse.text()}`);
  const workspaceData: unknown = await workspaceResponse.json();
  const workspaceSchema = Type.Object({ workspace: Type.Object({
    phase: Type.Object({ kind: Type.String() }),
    workViews: Type.Array(Type.Object({ key: Type.String(), reference: Type.Object({ type: Type.String({ minLength: 1 }) }) })),
  }) });
  if (!Value.Check(workspaceSchema, workspaceData)) throw new Error('The tuner needs a running workspace with Work views.');
  if (workspaceData.workspace.phase.kind !== 'runningPhase') throw new Error('Wait for the workspace to finish starting before opening the tuner.');
  const workViews = workspaceData.workspace.workViews;
  const selected = workspaceUrl.searchParams.get('workView') ?? workViews.find(view => view.reference.type === startingSettings.view)?.key ?? workViews[0]?.key;
  if (!selected || !workViews.some(view => view.key === selected)) throw new Error('Choose an available Work view in the workspace URL.');
  workspaceUrl.searchParams.set('workView', selected);
  const localWorkspaceUrl = `${workspaceUrl.pathname}${workspaceUrl.search}`;
  const optionsHtml = workViews.map(view => `<option value="${escapeHtml(view.key)}"${view.key === selected ? ' selected' : ''}>${escapeHtml(view.reference.type[0]!.toUpperCase() + view.reference.type.slice(1))}</option>`).join('');
  const root = new URL('./surface-lighting-tuner/', import.meta.url);

  interface Connection {
    destination: string;
    queue: (string | Uint8Array<ArrayBuffer>)[];
    upstream?: WebSocket;
  }

  const server = Bun.serve<Connection>({
    port,
    async fetch(request, server) {
      const rejection = managementOriginRejection(request);
      if (rejection) return rejection;
      const url = new URL(request.url);
      if (url.pathname === '/__lighting-tuner/client.js') {
        const build = await Bun.build({ entrypoints: [new URL('client.ts', root).pathname], target: 'browser' });
        if (!build.success) throw new AggregateError(build.logs, 'Could not bundle the lighting tuner');
        return new Response(build.outputs[0], { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/') {
        const template = await Bun.file(new URL('tuner.html', root)).text();
        const html = template.replaceAll('{{workspaceUrl}}', escapeHtml(localWorkspaceUrl))
          .replaceAll('{{viewInitial}}', escapeHtml(selected))
          .replace('{{viewOptions}}', optionsHtml);
        return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
      }
      const upstreamUrl = new URL(`${origin}${url.pathname}${url.search}`);
      if (request.headers.get('upgrade') === 'websocket') {
        upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        if (server.upgrade(request, { data: { destination: upstreamUrl.toString(), queue: [] } })) return;
        throw new Error('Could not upgrade the lighting preview WebSocket');
      }
      const headers = new Headers(request.headers);
      for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-agents-in-the-cloud-public-origin', 'x-agents-in-the-cloud-origin-context']) headers.delete(name);
      headers.set('host', upstreamUrl.host);
      headers.set('origin', origin);
      headers.set('accept-encoding', 'identity');
      const response = await fetch(new Request(upstreamUrl, { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body, redirect: 'manual' }));
      const outgoing = new Headers(response.headers);
      outgoing.delete('content-encoding');
      outgoing.delete('content-length');
      return new Response(response.body, { status: response.status, headers: outgoing });
    },
    websocket: {
      open(socket) {
        // SAFETY: This tool runs in Bun, which supports headers in WebSocketOptions.
        const Socket = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
        const upstream = new Socket(socket.data.destination, { headers: { Origin: origin } });
        upstream.binaryType = 'arraybuffer';
        socket.data.upstream = upstream;
        upstream.addEventListener('open', () => {
          for (const message of socket.data.queue) upstream.send(message);
          socket.data.queue = [];
        });
        upstream.addEventListener('message', event => socket.send(event.data));
        upstream.addEventListener('close', () => socket.close());
        upstream.addEventListener('error', () => socket.close(1011, 'Management WebSocket unavailable'));
      },
      message(socket, message) {
        if (socket.data.upstream!.readyState === WebSocket.OPEN) socket.data.upstream!.send(message);
        else socket.data.queue.push(message instanceof Uint8Array ? new Uint8Array(message) : message);
      },
      close(socket) { socket.data.upstream!.close(); },
    },
  });
  console.log(`Lighting tuner: ${server.url}\nWorkspace: ${workspaceUrl}\nRefresh the tuner after editing its source or saved settings.`);
  return server;
}

if (import.meta.main) {
  const destination = Bun.argv[2];
  if (!destination) throw new Error('Usage: bun run apps/web/scripts/surface-lighting-tuner.ts http://localhost:3000/workspaces/<id>');
  await startLightingTuner(destination);
}
