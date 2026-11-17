import dns from "node:dns/promises";
import { isIP } from "node:net";
import type { AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { hostAvailable, hostRequest } from "@agents-in-the-cloud/host/connection";
import type { PrivateNetworkFirewallEntry } from "@agents-in-the-cloud/host/protocol";
import { isPrivateNetworkAddress } from "@agents-in-the-cloud/shared/egress-policy";
import { workspaceBridgeName, type WorkspaceInitInstruction } from "@agents-in-the-cloud/workspace";
import { effectivePrivateNetworkAccess, formatPrivateNetworkDestination, onWorkspaceTemplateStoreChanged, workspaceTemplateIdOfInit, type PrivateNetworkDestination } from "@agents-in-the-cloud/workspace-templates";

type ResolveHost = (host: string) => Promise<string[]>;

const refreshInterval = 60_000;

const reported = new Set<string>();
function report(message: string): void {
  if (reported.has(message)) return;
  reported.add(message);
  console.error(message);
}

const resolveHost: ResolveHost = async (host) => isIP(host) ? [host] : (await dns.lookup(host, { all: true, family: 4 })).map(({ address }) => address);

/** The firewall entries for each workspace's listed destinations. Only private IPv4
 * addresses are opened; workspace bridges have no IPv6. An unresolvable host is
 * reported and skipped so it can't hold back every other workspace's access. */
export async function privateNetworkFirewallDestinations(workspaces: ReadonlyMap<string, PrivateNetworkDestination[]>, resolve: ResolveHost = resolveHost): Promise<PrivateNetworkFirewallEntry[]> {
  const hosts = new Set([...workspaces.values()].flatMap((destinations) => destinations.map(({ host }) => host)));
  const resolved = new Map(await Promise.all([...hosts].map(async (host) => [host, await resolve(host).catch((error) => {
    report(`Private network access: could not resolve ${host}: ${String(error)}`);
    return undefined;
  })] as const)));
  return [...workspaces].flatMap(([workspaceId, destinations]) => destinations.flatMap((destination) => {
    const addresses = resolved.get(destination.host);
    if (!addresses) return [];
    const usable = addresses.filter((address) => isIP(address) === 4 && isPrivateNetworkAddress(address));
    if (!usable.length) report(`Private network access: ${formatPrivateNetworkDestination(destination)} has no private IPv4 address; direct connections stay blocked`);
    return usable.map((address) => ({ bridge: workspaceBridgeName(workspaceId), address, port: destination.port }));
  }));
}

/** Keeps System's firewall in step with Private network access. Without System
 * (development and nested installations) there is no firewall to update; the
 * egress proxy enforces the same list for HTTP either way. */
export function startPrivateNetworkFirewallSync(events: AgentsInTheCloudEventBus, existing: ReadonlyArray<{ id: string; init?: WorkspaceInitInstruction }>): void {
  if (!hostAvailable()) return;
  const workspaceTemplates = new Map(existing.map((workspace) => [workspace.id, workspaceTemplateIdOfInit(workspace.init)]));

  let running: Promise<void> | undefined;
  let pending = false;
  const sync = async () => {
    const workspaces = new Map<string, PrivateNetworkDestination[]>();
    for (const [workspaceId, workspaceTemplateId] of workspaceTemplates) workspaces.set(workspaceId, await effectivePrivateNetworkAccess(workspaceTemplateId));
    await hostRequest({ operation: "private-network-access", destinations: await privateNetworkFirewallDestinations(workspaces) });
  };
  const schedule = () => {
    if (running) { pending = true; return; }
    running = sync()
      .catch((error) => console.error("Private network access: could not update the System firewall", error))
      .finally(() => {
        running = undefined;
        if (pending) { pending = false; schedule(); }
      });
  };

  events.on("workspace_plan_prepare", ({ workspaceId, init }) => { workspaceTemplates.set(workspaceId, workspaceTemplateIdOfInit(init)); schedule(); });
  events.on("workspace_deleted", ({ workspaceId }) => { workspaceTemplates.delete(workspaceId); schedule(); });
  onWorkspaceTemplateStoreChanged(schedule);
  const timer = setInterval(schedule, refreshInterval);
  events.on("agents_in_the_cloud_host_stopping", () => clearInterval(timer));
  schedule();
}
