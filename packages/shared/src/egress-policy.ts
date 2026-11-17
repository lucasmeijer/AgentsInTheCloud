import { BlockList, isIP } from "node:net";

/**
 * The workspace egress invariant: over IP, a workspace may reach global
 * unicast destinations (the public internet) and nothing else.
 *
 * AgentsInTheCloud's own services are never valid destinations. The app, the
 * supervisor and every other control channel are reached through per-workspace
 * Unix sockets with fixed route lists, not through the network. Private
 * networks (LAN, VPN, tailnet, Docker bridges) are not reachable either, except
 * for exact host:port destinations the user lists under Private network access.
 * Those may only resolve to the private network ranges below.
 *
 * This module is the one policy definition for both enforcement layers: the
 * System nftables firewall (images/system/src/firewall.ts) and the egress
 * proxy's destination check (packages/proxy-egress), so they cannot drift.
 */

export const blockedEgressIpv4Ranges: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export const allowedEgressIpv6Range = { address: "2000::", prefix: 3 } as const;

export const blockedEgressIpv6Ranges: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["2001:db8::", 32],
];

const blockedIpv4 = new BlockList();
for (const [address, prefix] of blockedEgressIpv4Ranges) blockedIpv4.addSubnet(address, prefix, "ipv4");

const allowedIpv6 = new BlockList();
allowedIpv6.addSubnet(allowedEgressIpv6Range.address, allowedEgressIpv6Range.prefix, "ipv6");

const blockedIpv6 = new BlockList();
for (const [address, prefix] of blockedEgressIpv6Ranges) blockedIpv6.addSubnet(address, prefix, "ipv6");

/**
 * Private networks a user may open exact host:port destinations into. Loopback,
 * link-local (cloud metadata) and special-purpose ranges are never allowed, and
 * neither is 172.16.0.0/12: System allocates every Docker network from it, so
 * it would reach other workspaces and System itself.
 */
export const privateNetworkIpv4Ranges: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["192.168.0.0", 16],
];

export const privateNetworkIpv6Range = { address: "fc00::", prefix: 7 } as const;

const privateIpv4 = new BlockList();
for (const [address, prefix] of privateNetworkIpv4Ranges) privateIpv4.addSubnet(address, prefix, "ipv4");

const privateIpv6 = new BlockList();
privateIpv6.addSubnet(privateNetworkIpv6Range.address, privateNetworkIpv6Range.prefix, "ipv6");

export function isPrivateNetworkAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return privateIpv4.check(ip, "ipv4");
  if (family === 6) return privateIpv6.check(ip, "ipv6");
  return false;
}

export function isWorkspaceEgressAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blockedIpv4.check(ip, "ipv4");
  if (family === 6) return allowedIpv6.check(ip, "ipv6") && !blockedIpv6.check(ip, "ipv6");
  return false;
}

export function workspaceEgressNftIpv4Elements(): string {
  return blockedEgressIpv4Ranges.map(([address, prefix]) => `${address}/${prefix}`).join(",\n      ");
}
