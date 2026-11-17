import { isIP } from "node:net";
import { invalidArguments } from "@agents-in-the-cloud/core";
import { isPrivateNetworkAddress } from "@agents-in-the-cloud/shared/egress-policy";
import { findConfigurationRecord, workspaceScopes, workspaceTemplatesFile, readWorkspaceTemplateStore, updateWorkspaceTemplateStore, type ConfigurationScope } from "./workspace-template.ts";

export interface PrivateNetworkDestination { host: string; port: number }

const hostnamePattern = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

export function parsePrivateNetworkDestination(entry: string): PrivateNetworkDestination {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(entry.trim().toLowerCase());
  const port = Number(match?.[3]);
  if (!match || port < 1 || port > 65535) throw invalidArguments(`Use host:port, for example db.internal:5432 (not “${entry.trim()}”)`);
  const host = match[1] ?? match[2]!;
  if (match[1] !== undefined && isIP(host) !== 6) throw invalidArguments(`“${entry.trim()}” isn’t an IPv6 address`);
  if (isIP(host)) {
    if (!isPrivateNetworkAddress(host)) throw invalidArguments(`${host} isn’t on a private network. Only 10.x, 100.64–127.x, 192.168.x and fc00::/7 addresses can be added.`);
  } else if (!hostnamePattern.test(host)) throw invalidArguments(`“${host}” isn’t a valid hostname`);
  return { host, port };
}

export function requestedPrivateNetworkDestination(hostname: string, port: number): PrivateNetworkDestination {
  return { host: hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1"), port };
}

export function formatPrivateNetworkDestination({ host, port }: PrivateNetworkDestination): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export async function setPrivateNetworkAccess(scope: ConfigurationScope, input: string, file = workspaceTemplatesFile()): Promise<string[]> {
  const entries = [...new Set(input.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => formatPrivateNetworkDestination(parsePrivateNetworkDestination(line))))];
  return await updateWorkspaceTemplateStore(file, (store) => {
    const configuration = findConfigurationRecord(store, scope);
    if (entries.length) configuration.privateNetworkAccess = entries;
    else delete configuration.privateNetworkAccess;
    return entries;
  });
}

export async function effectivePrivateNetworkAccess(workspaceTemplateId?: string, file = workspaceTemplatesFile()): Promise<PrivateNetworkDestination[]> {
  const store = await readWorkspaceTemplateStore(file);
  const entries = new Set(workspaceScopes(workspaceTemplateId).flatMap((scope) => findConfigurationRecord(store, scope).privateNetworkAccess ?? []));
  return [...entries].map(parsePrivateNetworkDestination);
}
