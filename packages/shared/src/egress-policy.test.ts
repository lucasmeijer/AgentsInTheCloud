import { expect, test } from "bun:test";
import { blockedEgressIpv4Ranges, blockedEgressIpv6Ranges, isPrivateNetworkAddress, isWorkspaceEgressAddress, workspaceEgressNftIpv4Elements } from "./egress-policy.ts";

test("public internet addresses are the only allowed egress destinations", () => {
  for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "2606:4700:10::6814:179a", "2001:4860:4860::8888"]) {
    expect(isWorkspaceEgressAddress(ip)).toBe(true);
  }
});

test("every private and special-purpose range is denied", () => {
  const denied = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.100", "100.127.255.255",
    "127.0.0.1", "127.255.255.255", "169.254.169.254", "169.254.1.1", "172.16.0.1", "172.31.255.255",
    "192.0.0.9", "192.0.2.1", "192.168.1.1", "192.168.0.100", "198.18.0.1", "198.19.255.255",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fc00::1", "fd00::1", "fd7a:115c:a1e0::1",
    "fe80::1", "ff02::1", "2001:db8::1",
  ];
  for (const ip of denied) expect(isWorkspaceEgressAddress(ip), ip).toBe(false);
  for (const ip of ["example.com", "", "93.184.215.14 ", "2001:db8::g"]) expect(isWorkspaceEgressAddress(ip)).toBe(false);
});

test("the nft element list matches the checked ranges", () => {
  const elements = workspaceEgressNftIpv4Elements().split(",").map(element => element.trim());
  expect(elements).toEqual(blockedEgressIpv4Ranges.map(([address, prefix]) => `${address}/${prefix}`));
  expect(blockedEgressIpv6Ranges).toEqual([["2001:db8::", 32]]);
});

test("private network access may only open LAN, VPN and tailnet addresses", () => {
  for (const ip of ["10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.100", "192.168.1.1", "fd00::1", "fd7a:115c:a1e0::1", "fc00::1"])
    expect(isPrivateNetworkAddress(ip), ip).toBe(true);
  for (const ip of ["172.16.0.1", "172.17.0.1", "172.31.255.255", "127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "8.8.8.8", "::1", "fe80::1", "::ffff:10.0.0.1", "2001:4860:4860::8888", "db.internal", ""])
    expect(isPrivateNetworkAddress(ip), ip).toBe(false);
});
