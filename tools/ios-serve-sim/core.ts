import { shellQuote } from "@agents-in-the-cloud/core";
import { parseArgs } from 'node:util';
const serveSimVersion = '0.1.47';
const nodeVersion = '22.22.0';

export function port(value: string): number {
  if (!/^\d+$/.test(value)) throw Error(`Invalid port: ${value}`);
  const result = Number(value);
  if (result < 1024 || result > 65535 || result === 2999 || result === 24800) {
    throw Error(`Port must be 1024–65535, excluding 2999 and 24800: ${value}`);
  }
  return result;
}

export function serveOptions(args: string[]) {
  const separator = args.indexOf('--');
  const { values } = parseArgs({
    args: separator === -1 ? args : args.slice(0, separator),
    options: {
      'local-port': { type: 'string', default: '4101' },
      'remote-port': { type: 'string', default: '43201' },
      model: { type: 'string', default: 'iPhone 17' },
    },
  });
  const upstream = separator === -1 ? [] : args.slice(separator + 1);
  for (let i = 0; i < upstream.length; i++) {
    const arg = upstream[i]!;
    if (['--fit', '--quiet', '-q', '--exit-on-simulator-shutdown'].includes(arg)) continue;
    if (['--panes', '--theme', '--codec'].includes(arg) && upstream[i + 1] !== undefined) { i++; continue; }
    throw Error(`Unsupported viewer option: ${arg}. Use --model to create an owned device; exec passes other serve-sim commands through.`);
  }
  return { local: port(values['local-port']!), remote: port(values['remote-port']!), model: values.model!, upstream };
}

const environment = (root: string) =>
  `export PATH="${root}/node/bin:${root}/npm/node_modules/.bin:$PATH"; export TMPDIR="${root}/tmp/"`;

export const remoteCommand = (args: string[], root: string) =>
  `${environment(root)}; exec serve-sim ${args.map(shellQuote).join(' ')}`;

export const installScript = (installationRoot: string) => `set -eu
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'serve-sim requires an Apple Silicon Mac' >&2; exit 1; }
xcrun simctl help >/dev/null
root="${installationRoot}"
mkdir -p "$root/tmp" "$root/node"
${environment(installationRoot)}
archive="node-v${nodeVersion}-darwin-arm64.tar.gz"
curl -fL "https://nodejs.org/dist/v${nodeVersion}/$archive" -o "$root/tmp/$archive"
curl -fL https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt -o "$root/tmp/SHASUMS256.txt"
(cd "$root/tmp"; grep " $archive$" SHASUMS256.txt | shasum -a 256 -c -)
tar -xzf "$root/tmp/$archive" --strip-components=1 -C "$root/node"
npm install --cache "$root/npm-cache" --prefix "$root/npm" --no-audit --no-fund serve-sim@${serveSimVersion}
serve-sim --version
`;
