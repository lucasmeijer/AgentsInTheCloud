// Portions adapted from @earendil-works/gondolin, Apache-2.0.
// Source: https://github.com/earendil-works/gondolin

import crypto from "node:crypto";
import { HttpRequestBlockedError } from "./errors.ts";
import { isInternalAddress } from "./ip.ts";
import { matchesAnyHost, normalizeHostnamePattern } from "./patterns.ts";

type HttpIpAllowInfo = {
  hostname: string;
  ip: string;
  family: 4 | 6;
  port: number;
  protocol: "http" | "https";
};

export type HttpHooks = {
  isRequestAllowed?: (request: Request) => Promise<boolean> | boolean;
  isIpAllowed?: (info: HttpIpAllowInfo) => Promise<boolean> | boolean;
  onRequest?: (request: Request) => Promise<Request | Response | void> | Request | Response | void;
  scrubResponseHeader?: (value: string, request: Request) => string;
  onResponse?: (response: Response, request: Request) => Promise<Response | void> | Response | void;
};

export type RegisterRequestSecret = (value: string) => void;
export type SecretRequestTransform = (request: Request, registerSecret: RegisterRequestSecret) => Promise<Request>;

export type SecretDefinition = { hosts: string[]; value: string; allowInPath?: boolean; resolve?: () => Promise<string>; placeholder?: string };
export type CreateHttpHooksOptions = {
  allowedHosts?: string[];
  allowedInternalHosts?: string[];
  secrets?: Record<string, SecretDefinition>;
  blockInternalRanges?: boolean;
  isRequestAllowed?: HttpHooks["isRequestAllowed"];
  isIpAllowed?: HttpHooks["isIpAllowed"];
  onRequest?: (request: Request, registerSecret: RegisterRequestSecret) => ReturnType<NonNullable<HttpHooks["onRequest"]>>;
  onResponse?: HttpHooks["onResponse"];
};
export type SecretInfo = { name: string; placeholder: string; hosts: string[] };
export type RequestTransformHttpHooks = Omit<HttpHooks, "onRequest"> & {
  onRequest(request: Request): Promise<Request>;
  scrubResponseHeader: NonNullable<HttpHooks["scrubResponseHeader"]>;
};
export type CreateHttpHooksResult<Hooks extends HttpHooks = HttpHooks> = { httpHooks: Hooks; env: Record<string, string>; allowedHosts: string[]; secrets: SecretInfo[] };

type SecretEntry = SecretDefinition & { name: string; placeholder: string };

export function createHttpHooks(options?: CreateHttpHooksOptions & { onRequest?: undefined }): CreateHttpHooksResult<RequestTransformHttpHooks>;
export function createHttpHooks(options: CreateHttpHooksOptions & { onRequest: SecretRequestTransform }): CreateHttpHooksResult<RequestTransformHttpHooks>;
export function createHttpHooks(options: CreateHttpHooksOptions): CreateHttpHooksResult;
export function createHttpHooks(options: CreateHttpHooksOptions = {}): CreateHttpHooksResult {
  const env: Record<string, string> = {};
  const blockInternalRanges = options.blockInternalRanges ?? true;
  const configuredAllowedHosts = options.allowedHosts === undefined ? ["*"] : uniqueHosts(options.allowedHosts);
  const allowedInternalHosts = uniqueHosts(options.allowedInternalHosts ?? []);
  const allowedHosts = configuredAllowedHosts.includes("*") ? ["*"] : uniqueHosts([...configuredAllowedHosts, ...allowedInternalHosts]);
  const entries: SecretEntry[] = [];

  for (const [name, secret] of Object.entries(options.secrets ?? {})) {
    const placeholder = secret.placeholder ?? makeDefaultSecretPlaceholder();
    if (!placeholder) throw new Error(`invalid placeholder for secret: ${name}`);
    assertSecretPlaceholderIsSafe(name, placeholder, entries);
    env[name] = placeholder;
    entries.push({ ...secret, name, placeholder, hosts: uniqueHosts(secret.hosts) });
  }

  // Keep refreshed credentials attached to the exact request, not a mutable
  // "latest token": concurrent requests can use different credential versions.
  const requestSecrets = new WeakMap<Request, string[]>();
  const configuredSecrets = entries.flatMap(entry => responseSecretForms(entry.value));

  const secrets = entries.map((entry) => ({ name: entry.name, placeholder: entry.placeholder, hosts: [...entry.hosts] }));

  const applySecretsToRequest = async (request: Request, injectedSecrets: string[]): Promise<Request> => {
    const hostname = getHostname(request.url);
    const resolvedEntries = await Promise.all(entries.map(async (entry) => {
      if (!entry.resolve) return entry;
      const usedInHeaders = requestContainsSecretValuesInHeaders(request.headers, [entry.placeholder]);
      const usedInUrl = entry.allowInPath
        && (new URL(request.url).pathname.includes(entry.placeholder) || requestContainsSecretValuesInQuery(request.url, [entry.placeholder]));
      const resolve = matchesAnyHost(hostname, entry.hosts) && (usedInHeaders || usedInUrl);
      return { ...entry, value: resolve ? await entry.resolve() : entry.value };
    }));
    assertSecretValuesAllowedForHost(request, hostname, resolvedEntries);
    const headers = replaceSecretPlaceholdersInHeaders(request.headers, hostname, resolvedEntries);
    const url = replaceSecretPlaceholdersInUrl(request.url, hostname, resolvedEntries);
    const transformed = url === request.url ? request : cloneRequestWith(request, { url, headers });
    if (transformed === request && headers !== request.headers) headers.forEach((value, name) => request.headers.set(name, value));
    const knownValues = [...injectedSecrets, ...resolvedEntries.map(entry => entry.value)].filter(Boolean);
    // Basic auth encodes the username and password together. Protect the exact
    // wire representation, not base64(secret), which is not present on the wire.
    const encodedCredentials = basicAuthSecretRepresentations(headers, knownValues);
    const extraSecrets = [...injectedSecrets, ...resolvedEntries.filter(entry => entry.resolve).map(entry => entry.value), ...encodedCredentials];
    requestSecrets.set(transformed, [...new Set([...configuredSecrets, ...extraSecrets.flatMap(responseSecretForms)])]);
    return transformed;
  };

  const onRequest: NonNullable<HttpHooks["onRequest"]> = async (request) => {
    let nextRequest = request;
    const injectedSecrets: string[] = [];
    if (options.onRequest) {
      const updated = await options.onRequest(nextRequest, value => { injectedSecrets.push(value); });
      if (updated instanceof Response) {
        requestSecrets.set(request, [...configuredSecrets, ...injectedSecrets.flatMap(responseSecretForms)]);
        return updated;
      }
      if (updated) nextRequest = updated;
    }
    return applySecretsToRequest(nextRequest, injectedSecrets);
  };

  return {
    env,
    allowedHosts,
    secrets,
    httpHooks: {
      isRequestAllowed: options.isRequestAllowed ?? (() => true),
      isIpAllowed: async (info) => {
        if (!matchesAnyHost(info.hostname, allowedHosts)) return false;
        if (blockInternalRanges && isInternalAddress(info.ip) && !matchesAnyHost(info.hostname, allowedInternalHosts)) return false;
        return options.isIpAllowed ? options.isIpAllowed(info) : true;
      },
      onRequest,
      onResponse: options.onResponse,
      scrubResponseHeader: (value, request) => scrubSecretValues(value, requestSecrets.get(request) ?? configuredSecrets),
    },
  };
}

export function makeDefaultSecretPlaceholder(): string {
  return `AGENTSINTHECLOUD_SECRET_${crypto.randomBytes(24).toString("hex")}`;
}

function assertSecretPlaceholderIsSafe(name: string, placeholder: string, existingEntries: Iterable<SecretEntry>): void {
  for (const entry of existingEntries) {
    if (placeholder === entry.placeholder) throw new Error(`duplicate secret placeholder: ${placeholder}`);
    if (placeholder.includes(entry.placeholder) || entry.placeholder.includes(placeholder)) {
      throw new Error(`secret placeholder for ${name} overlaps with secret placeholder for ${entry.name}`);
    }
  }
}

function cloneRequestWith(request: Request, options: { url: string; headers: Headers }): Request {
  const method = request.method.toUpperCase();
  const canHaveBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers: options.headers, body: canHaveBody ? request.body : undefined };
  if (canHaveBody && request.body) init.duplex = "half";
  return new Request(options.url, init);
}
function getHostname(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function assertSecretValuesAllowedForHost(request: Request, hostname: string, entries: SecretEntry[]) {
  for (const entry of entries) {
    if (matchesAnyHost(hostname, entry.hosts)) continue;
    if (requestContainsSecretValuesInHeaders(request.headers, [entry.value]) || (entry.allowInPath && requestContainsSecretValuesInQuery(request.url, [entry.value]))) throw new HttpRequestBlockedError(`secret ${entry.name} not allowed for host: ${hostname || "unknown"}`);
  }
}

function requestContainsSecretValuesInHeaders(headers: Headers, values: string[]): boolean {
  const nonEmpty = values.filter(Boolean);
  for (const [name, value] of headers.entries()) {
    for (const secret of nonEmpty) if (value.includes(secret) || (/^(authorization|proxy-authorization)$/i.test(name) && (decodeBasicAuth(value)?.includes(secret)))) return true;
  }
  return false;
}
function requestContainsSecretValuesInQuery(url: string, values: string[]): boolean {
  const secrets = values.filter(Boolean);
  return [...new URL(url).searchParams].some(([name, value]) => secrets.some((secret) => name.includes(secret) || value.includes(secret)));
}

function decodeBasicAuth(value: string): string | null {
  const match = value.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[3]!, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function basicAuthSecretRepresentations(headers: Headers, secrets: string[]): string[] {
  const representations: string[] = [];
  for (const name of ["authorization", "proxy-authorization"]) {
    const value = headers.get(name);
    if (!value) continue;
    const match = value.match(/^Basic\s+(\S+)\s*$/i);
    if (!match) continue;
    const decoded = decodeBasicAuth(value)!;
    if (secrets.some(secret => value.includes(secret) || decoded.includes(secret))) representations.push(match[1]!);
  }
  return representations;
}

function collectStringMatchRanges(container: string, search: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  if (!search) return ranges;
  for (let start = container.indexOf(search); start !== -1; start = container.indexOf(search, start + 1)) {
    ranges.push({ start, end: start + search.length });
  }
  return ranges;
}

function replaceSecretPlaceholdersInHeaders(incomingHeaders: Headers, hostname: string, entries: SecretEntry[]): Headers {
  let headers: Headers | null = null;
  for (const [headerName, value] of incomingHeaders.entries()) {
    let updated = replaceSecretPlaceholdersInString(value, hostname, entries);
    updated = replaceBasicAuthSecretPlaceholders(headerName, updated, hostname, entries);
    if (updated !== value) { headers ??= new Headers(incomingHeaders); headers.set(headerName, updated); }
  }
  return headers ?? incomingHeaders;
}
function replaceSecretPlaceholdersInUrl(url: string, hostname: string, entries: SecretEntry[]): string {
  const urlEntries = entries.filter((entry) => entry.allowInPath && matchesAnyHost(hostname, entry.hosts));
  if (urlEntries.length === 0) return url;
  const parsed = new URL(url);
  let changed = false;
  const pathname = replaceSecretPlaceholdersInString(parsed.pathname, hostname, urlEntries);
  if (pathname !== parsed.pathname) { parsed.pathname = pathname; changed = true; }
  let queryChanged = false;
  const params = new URLSearchParams();
  for (const [name, value] of parsed.searchParams) {
    const nextName = replaceSecretPlaceholdersInString(name, hostname, urlEntries);
    const nextValue = replaceSecretPlaceholdersInString(value, hostname, urlEntries);
    queryChanged ||= nextName !== name || nextValue !== value;
    params.append(nextName, nextValue);
  }
  if (queryChanged) { parsed.search = params.toString(); changed = true; }
  return changed ? parsed.toString() : url;
}
function replaceBasicAuthSecretPlaceholders(headerName: string, headerValue: string, hostname: string, entries: SecretEntry[]): string {
  if (!/^(authorization|proxy-authorization)$/i.test(headerName)) return headerValue;
  const match = headerValue.match(/^(Basic)(\s+)(\S+)(\s*)$/i);
  if (!match) return headerValue;
  const decoded = decodeBasicAuth(headerValue);
  if (!decoded) return headerValue;
  const updated = replaceSecretPlaceholdersInString(decoded, hostname, entries);
  return updated === decoded ? headerValue : `${match[1]}${match[2]}${Buffer.from(updated, "utf8").toString("base64")}${match[4] ?? ""}`;
}
function replaceSecretPlaceholdersInString(value: string, hostname: string, entries: SecretEntry[]): string {
  const secretValueRanges = entries.flatMap((entry) => collectStringMatchRanges(value, entry.value));
  const replacements = entries.flatMap((entry) => collectStringMatchRanges(value, entry.placeholder).filter((range) => !secretValueRanges.some((s) => s.start <= range.start && s.end >= range.end)).map((range) => ({ ...range, entry })));
  if (!replacements.length) return value;
  replacements.sort((a, b) => a.start - b.start || b.end - a.end);
  let updated = "";
  let offset = 0;
  for (const replacement of replacements) {
    if (replacement.start < offset) continue;
    updated += value.slice(offset, replacement.start);
    if (!matchesAnyHost(hostname, replacement.entry.hosts)) throw new HttpRequestBlockedError(`secret ${replacement.entry.name} not allowed for host: ${hostname || "unknown"}`);
    updated += replacement.entry.value;
    offset = replacement.end;
  }
  return updated + value.slice(offset);
}
function uniqueHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map(normalizeHostnamePattern).filter(Boolean))];
}

// Match literal secrets and the common URL representations used by redirect
// headers. This is not a general defense against arbitrary server-side encoding.
function responseSecretForms(value: string): string[] {
  if (!value) return [];
  const path = new URL("https://secret.invalid");
  path.pathname = value;
  return [...new Set([value, path.pathname.slice(1), encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)])].filter(Boolean);
}

function scrubSecretValues(value: string, secrets: string[]): string {
  const ranges = secrets.flatMap(secret => collectStringMatchRanges(value, secret));
  if (!ranges.length) return value;
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  let result = "";
  let offset = 0;
  for (const range of ranges) {
    if (range.start >= offset) result += value.slice(offset, range.start) + "[REDACTED]";
    offset = Math.max(offset, range.end);
  }
  return result + value.slice(offset);
}
