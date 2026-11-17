import { isIP } from "node:net";
import { allowedEgressIpv6Range, blockedEgressIpv6Ranges, isPrivateNetworkAddress, workspaceEgressNftIpv4Elements } from "../../../packages/shared/src/egress-policy.ts";
import type { PrivateNetworkFirewallEntry } from "../../../packages/host/src/protocol.ts";

/** Every bridge-attached workload shares the destination policy. Host-side build
 * clients also use it when NFT_SOCKET is available. Management sockets are
 * never selected. On unsupported kernels host-side clients are unrestricted. */
export function workspaceFirewallRules(buildClientsCgroup: string, nameservers: string[], protectBuildClients = true): string {
  const parts = buildClientsCgroup.split("/").filter(Boolean);
  if (!buildClientsCgroup.startsWith("/") || !parts.length || parts.some(part => part === "." || part === ".." || !/^[a-zA-Z0-9_.-]+$/.test(part)))
    throw new Error("Invalid build client cgroup path");
  const selector = `socket cgroupv2 level ${parts.length} "${parts.join("/")}"`;
  const dnsRules = [...new Set(nameservers)].map(address => {
    const family = isIP(address);
    if (!family) throw new Error(`Invalid DNS server: ${address}`);
    return `    ${family === 4 ? "ip" : "ip6"} daddr ${address} meta l4proto { tcp, udp } th dport 53 counter accept`;
  });
  return `add table inet agents-in-the-cloud_workspaces
flush table inet agents-in-the-cloud_workspaces
table inet agents-in-the-cloud_workspaces {
  set non_public_v4 {
    type ipv4_addr; flags interval;
    elements = { ${workspaceEgressNftIpv4Elements()} }
  }
  set private_network_v4 {
    type ifname . ipv4_addr . inet_service;
  }
  chain public_egress {
${dnsRules.join("\n")}
    jump public_destinations
  }
  chain public_destinations {
    ip daddr @non_public_v4 counter drop
    ip6 daddr != ${allowedEgressIpv6Range.address}/${allowedEgressIpv6Range.prefix} counter drop
${blockedEgressIpv6Ranges.map(([address, prefix]) => `    ip6 daddr ${address}/${prefix} counter drop`).join("\n")}
  }
  chain output {
    type filter hook output priority -10; policy accept;
${protectBuildClients ? `    ${selector} jump public_egress` : ""}
  }
  chain input {
    type filter hook input priority -10; policy accept;
    meta iifkind "bridge" ct state established,related counter accept
    meta iifkind "bridge" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } counter accept
    meta iifkind "bridge" counter drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    meta iifkind "bridge" meta oifkind "bridge" counter drop
    meta iifkind "bridge" meta l4proto tcp iifname . ip daddr . tcp dport @private_network_v4 counter accept
    meta iifkind "bridge" jump public_destinations
  }
}
flush set inet agents-in-the-cloud_workspaces private_network_v4
${(["ip", "ip6"] as const).map(family => `add table ${family} agents-in-the-cloud_workspaces
flush table ${family} agents-in-the-cloud_workspaces
table ${family} agents-in-the-cloud_workspaces {
  chain forward {
    type filter hook forward priority -11; policy accept;
    meta iifkind "bridge" fib daddr type local counter drop
  }
${protectBuildClients ? `  chain local_destinations {
${dnsRules.filter(rule => rule.startsWith(`    ${family} `)).join("\n")}
    fib daddr type local counter drop
  }
  chain output {
    type filter hook output priority -11; policy accept;
    ${selector} jump local_destinations
  }
` : ""}}
`).join("")}`;
}

/** Atomically replaces every workspace's private network destinations. Only
 * the forward chain consults them, so the System host itself stays unreachable
 * through the family tables' local-address drop. */
export function privateNetworkAccessRules(destinations: readonly PrivateNetworkFirewallEntry[]): string {
  for (const { bridge, address, port } of destinations) {
    if (!/^atw-[a-f0-9]{11}$/.test(bridge)) throw new Error(`Invalid workspace bridge: ${bridge}`);
    if (isIP(address) !== 4 || !isPrivateNetworkAddress(address)) throw new Error(`Not a private network address: ${address}`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  }
  const elements = [...new Set(destinations.map(({ bridge, address, port }) => `"${bridge}" . ${address} . ${port}`))];
  return `flush set inet agents-in-the-cloud_workspaces private_network_v4
${elements.length ? `add element inet agents-in-the-cloud_workspaces private_network_v4 { ${elements.join(", ")} }\n` : ""}`;
}

/** Tailscale's Quad100 resolvers. With MagicDNS, tailscaled rewrites
 * /etc/resolv.conf to these after the firewall is installed. */
export const tailscaleResolvers = ["100.100.100.100", "fd7a:115c:a1e0::53"];

export function resolverAddresses(resolvConf: string): string[] {
  return resolvConf.split("\n").flatMap(line => {
    const match = /^\s*nameserver\s+(\S+)/.exec(line);
    return match ? [match[1]!] : [];
  });
}

async function nft(rules: string, check = false) {
  const process = Bun.spawn(["nft", ...(check ? ["-c"] : []), "-f", "-"], {
    stdin: new TextEncoder().encode(rules),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, diagnostic: error || output };
}

/** Check the expression against the running kernel without changing its ruleset.
 * The caller has already created the cgroup. Only the missing-expression error
 * permits omitting client rules; every other preflight error is fatal. */
export async function buildClientFirewallSupported(buildClientsCgroup: string): Promise<boolean> {
  workspaceFirewallRules(buildClientsCgroup, []);
  const parts = buildClientsCgroup.split("/").filter(Boolean);
  const result = await nft(`add table inet aitc_socket_preflight
add chain inet aitc_socket_preflight output { type filter hook output priority -10; policy accept; }
add rule inet aitc_socket_preflight output socket cgroupv2 level ${parts.length} "${parts.join("/")}" counter
`, true);
  if (result.code === 0) return true;
  if (result.diagnostic.includes("Could not process rule: No such file or directory")) return false;
  throw new Error(`Could not install workspace firewall: ${result.diagnostic}`);
}

export async function installWorkspaceFirewall(buildClientsCgroup: string, nameservers: string[]) {
  const protectBuildClients = await buildClientFirewallSupported(buildClientsCgroup);
  const result = await nft(workspaceFirewallRules(buildClientsCgroup, nameservers, protectBuildClients));
  if (result.code !== 0)
    throw new Error(`Could not install workspace firewall: ${result.diagnostic}`);
}

export async function setPrivateNetworkAccess(destinations: readonly PrivateNetworkFirewallEntry[]) {
  const result = await nft(privateNetworkAccessRules(destinations));
  if (result.code !== 0)
    throw new Error(`Could not update private network access: ${result.diagnostic}`);
}
