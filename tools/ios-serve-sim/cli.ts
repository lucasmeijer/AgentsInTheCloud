#!/usr/bin/env bun
import { shellQuote } from "@agents-in-the-cloud/core";
import { port, remoteCommand, serveOptions, installScript } from './core';
import { deviceName, guardedCommand, workspaceId, workspaceRoot } from './lifecycle';

const help = `ios-serve-sim — serve-sim on the remote Mac
Usage: bun tools/ios-serve-sim/cli.ts <command> [arguments]
Uses the existing REMOTEMAC=user@host setting.

  serve [--model "iPhone 17"] [--local-port 4101] [--remote-port 43201]
        -- [serve-sim options]   Create an owned simulator and run the viewer
  exec <serve-sim arguments>     Pass arguments and stdin directly to serve-sim
  forward <local-port> <remote-port>
                                Expose a workspace dev server on the Mac

Examples:
  bun tools/ios-serve-sim/cli.ts serve --model "iPhone 17" -- --fit --panes tools --codec mjpeg
  bun tools/ios-serve-sim/cli.ts exec --help
  bun tools/ios-serve-sim/cli.ts exec tap 0.5 0.5 -d <udid>
  bun tools/ios-serve-sim/cli.ts exec type "Hello!" -d <udid>
  bun tools/ios-serve-sim/cli.ts forward 3000 43000
  # Open http://localhost:43000 in Safari via the viewer's URL tool.

Run serve and forward in tmux so they stay available. serve installs its own
pinned tools and creates a workspace-owned simulator. Ctrl-C deletes that device
and its tools/data; workspace deletion or 45 seconds without heartbeats does too.
exec uses this workspace's tools and stream state; an active serve is required.
The viewer is upstream serve-sim; HTTP and WebSockets use the same port.
The Mac account is shared: don't use the viewer to boot other workspaces' devices
or run unrelated shell commands. Isolation is by convention, not a sandbox.
Files you explicitly export outside the workspace directory are not managed.
Upstream file arguments are paths on the Mac. Only share with trusted users.
`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log(help);
    return 0;
  }
  const host = process.env.REMOTEMAC;
  if (!host || host.startsWith('-')) throw Error('Set REMOTEMAC to user@host.');
  const ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3'];
  let remote: string;
  const id = workspaceId();
  const root = workspaceRoot(id);
  const managed = command === 'serve';
  switch (command) {
    case 'exec':
      if (!args.length) throw Error('Usage: exec <serve-sim arguments>');
      remote = `[ -d "${root}.lock" ] || { echo 'Start this workspace viewer with serve first.' >&2; exit 1; }; ${remoteCommand(args, root)}`;
      break;
    case 'serve': {
      const options = serveOptions(args);
      ssh.push('-L', `0.0.0.0:${options.local}:127.0.0.1:${options.remote}`);
      const script = `${installScript(root)}\nudid=$(xcrun simctl create ${shellQuote(deviceName(id))} ${shellQuote(options.model)})\necho "Workspace simulator: $udid"\n${remoteCommand(['--port', String(options.remote), ...options.upstream], root)} "$udid"`;
      remote = guardedCommand(id, script);
      console.log(`Preview: http://localhost:${options.local}/ (once serve-sim is ready)`);
      break;
    }
    case 'forward': {
      if (args.length !== 2) throw Error('Usage: forward <local-port> <remote-port>');
      const local = port(args[0]!);
      const remotePort = port(args[1]!);
      ssh.push('-R', `127.0.0.1:${remotePort}:127.0.0.1:${local}`, '-N');
      console.log(`Mac http://localhost:${remotePort} → workspace port ${local}`);
      remote = '';
      break;
    }
    default:
      throw Error(`Unknown wrapper command: ${command}. Use exec to run serve-sim commands.`);
  }
  ssh.push('-T', host);
  if (remote) ssh.push(remote);
  const child = Bun.spawn(ssh, { stdin: managed ? 'pipe' : 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const heartbeat = managed ? setInterval(() => {
    child.stdin!.write('\n');
    void child.stdin!.flush();
  }, 5000) : undefined;
  const stop = () => {
    clearInterval(heartbeat);
    if (managed) child.stdin!.end();
    else child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const code = await child.exited;
  clearInterval(heartbeat);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  return code;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
