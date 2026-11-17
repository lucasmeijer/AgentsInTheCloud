import { expect, test } from "bun:test";
import { privateNetworkAccessRules, resolverAddresses, tailscaleResolvers, workspaceFirewallRules } from "./firewall.ts";

test("all bridge kinds share the input and forwarding boundary, independent of names", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"]);
  expect(rules).not.toContain('iifname "');
  expect(rules).not.toContain("oifname");
  expect(rules).toContain('meta iifkind "bridge" counter drop');
  expect(rules).toContain('meta iifkind "bridge" meta oifkind "bridge" counter drop');
  expect(rules).toContain('meta iifkind "bridge" jump public_destinations');
  expect(rules).toContain('ip daddr @non_public_v4 counter drop');
  expect(rules).toContain('ip6 daddr != 2000::/3 counter drop');
  expect(rules).toContain('ip6 daddr 2001:db8::/32 counter drop');
});

test("preserves host-initiated replies and IPv6 neighbor discovery before the input deny", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"]);
  const deny = rules.indexOf('meta iifkind "bridge" counter drop');
  for (const exception of [
    'meta iifkind "bridge" ct state established,related counter accept',
    'meta iifkind "bridge" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } counter accept',
  ]) {
    expect(rules).toContain(exception);
    expect(rules.indexOf(exception)).toBeLessThan(deny);
  }
  expect(rules).toStartWith("add table inet agents-in-the-cloud_workspaces\nflush table inet agents-in-the-cloud_workspaces\n");
  expect(rules).not.toContain("flush ruleset");
});

test("build-client sockets are confined without affecting management sockets", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"]);
  expect(rules).toContain('socket cgroupv2 level 3 "system/workloads/build-clients" jump public_egress');
  expect(rules).toContain("fib daddr type local counter drop");
  expect(rules).toContain("ip daddr @non_public_v4 counter drop");
  expect(rules).toContain("ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 counter accept");
  const output = rules.slice(rules.indexOf("  chain public_egress"), rules.indexOf("  chain input"));
  expect(output).not.toContain("ct state");
  expect(output).toContain("jump public_destinations");
  for (const path of ["", "/", "relative", "/system/../management", '/system/"injection'])
    expect(() => workspaceFirewallRules(path, [])).toThrow("Invalid build client cgroup");
  expect(() => workspaceFirewallRules("/system/build-clients", ["invalid"])).toThrow("Invalid DNS");
});

test("DNS exceptions are limited to build clients, not forwarded workloads", () => {
  const nameservers = resolverAddresses("# resolver config\nnameserver 127.0.0.53\n nameserver fd00::53 # IPv6\nsearch example.com\n");
  expect(nameservers).toEqual(["127.0.0.53", "fd00::53"]);
  const rules = workspaceFirewallRules("/system/workloads/build-clients", nameservers);
  expect(rules).toContain("ip6 daddr fd00::53 meta l4proto { tcp, udp } th dport 53 counter accept");
  const forward = rules.slice(rules.indexOf("  chain forward"));
  expect(forward).toContain('meta iifkind "bridge" jump public_destinations');
  expect(forward).not.toContain("jump public_egress");
});

test("build clients can reach Tailscale's resolvers despite the tailnet drop", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", tailscaleResolvers);
  for (const [family, resolver] of [["ip", "100.100.100.100"], ["ip6", "fd7a:115c:a1e0::53"]]) {
    const rule = `${family} daddr ${resolver} meta l4proto { tcp, udp } th dport 53 counter accept`;
    const egress = rules.slice(rules.indexOf("  chain public_egress"));
    expect(egress.indexOf(rule)).toBeGreaterThan(-1);
    expect(egress.indexOf(rule)).toBeLessThan(egress.indexOf("jump public_destinations"));
  }
});

test("family-specific FIB rules avoid the optional inet FIB implementation", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53", "fd00::53"]);
  const inet = rules.slice(0, rules.indexOf("add table ip "));
  expect(inet).not.toContain("fib daddr");
  for (const family of ["ip", "ip6"]) {
    expect(rules).toContain(`add table ${family} agents-in-the-cloud_workspaces`);
    expect(rules).toContain(`flush table ${family} agents-in-the-cloud_workspaces`);
  }
  expect(rules.match(/fib daddr type local counter drop/g)).toHaveLength(4);
  // An accept in the inet table doesn't bypass a later family table. Each
  // family's output chain must independently exempt configured DNS before FIB.
  for (const [family, resolver] of [["ip", "127.0.0.53"], ["ip6", "fd00::53"]]) {
    const table = rules.slice(rules.indexOf(`table ${family} agents-in-the-cloud_workspaces {`));
    const local = table.slice(table.indexOf("chain local_destinations"));
    expect(local.indexOf(`${family} daddr ${resolver}`)).toBeLessThan(local.indexOf("fib daddr"));
  }
});

test("without NFT_SOCKET only host-side client filtering is omitted", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"], false);
  expect(rules).not.toContain("socket cgroupv2");
  expect(rules).not.toContain("chain local_destinations");
  expect(rules.match(/meta iifkind "bridge" fib daddr type local counter drop/g)).toHaveLength(2);
  expect(rules).toContain('meta iifkind "bridge" counter drop');
  expect(rules).toContain('meta iifkind "bridge" meta oifkind "bridge" counter drop');
  expect(rules).toContain('meta iifkind "bridge" jump public_destinations');
  expect(rules).toContain("ip daddr @non_public_v4 counter drop");
});

test("private network destinations are opened per workspace bridge, before the public-only boundary", () => {
  const rules = workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53"]);
  const forward = rules.slice(rules.indexOf("  chain forward"));
  const allow = 'meta iifkind "bridge" meta l4proto tcp iifname . ip daddr . tcp dport @private_network_v4 counter accept';
  expect(rules).toContain("type ifname . ipv4_addr . inet_service;");
  expect(rules).toContain("}\nflush set inet agents-in-the-cloud_workspaces private_network_v4\n");
  expect(forward.indexOf('meta iifkind "bridge" meta oifkind "bridge" counter drop')).toBeLessThan(forward.indexOf(allow));
  expect(forward.indexOf(allow)).toBeLessThan(forward.indexOf('meta iifkind "bridge" jump public_destinations'));
  for (const family of ["ip", "ip6"]) {
    const table = rules.slice(rules.indexOf(`table ${family} agents-in-the-cloud_workspaces {`));
    expect(table).toContain("type filter hook forward priority -11");
    expect(table).toContain('meta iifkind "bridge" fib daddr type local counter drop');
  }
});

test("private network access replaces every destination in one batch", () => {
  expect(privateNetworkAccessRules([
    { bridge: "atw-0123456789a", address: "10.1.2.3", port: 5432 },
    { bridge: "atw-0123456789a", address: "10.1.2.3", port: 5432 },
    { bridge: "atw-bbbbbbbbbbb", address: "192.168.1.20", port: 443 },
  ])).toBe(`flush set inet agents-in-the-cloud_workspaces private_network_v4
add element inet agents-in-the-cloud_workspaces private_network_v4 { "atw-0123456789a" . 10.1.2.3 . 5432, "atw-bbbbbbbbbbb" . 192.168.1.20 . 443 }
`);
  expect(privateNetworkAccessRules([])).toBe("flush set inet agents-in-the-cloud_workspaces private_network_v4\n");
});

test("private network access rejects anything but private IPv4 destinations on workspace bridges", () => {
  const valid = { bridge: "atw-0123456789a", address: "10.1.2.3", port: 22 };
  for (const address of ["172.17.0.1", "127.0.0.1", "169.254.169.254", "8.8.8.8", "fd00::1", "db.internal", "10.0.0.1 } ; flush ruleset"])
    expect(() => privateNetworkAccessRules([{ ...valid, address }]), address).toThrow("Not a private network address");
  for (const bridge of ["docker0", "atw-test1", 'atw-0123456789a" . 10.0.0.1'])
    expect(() => privateNetworkAccessRules([{ ...valid, bridge }]), bridge).toThrow("Invalid workspace bridge");
  for (const port of [0, 65536, 1.5])
    expect(() => privateNetworkAccessRules([{ ...valid, port }])).toThrow("Invalid port");
});
