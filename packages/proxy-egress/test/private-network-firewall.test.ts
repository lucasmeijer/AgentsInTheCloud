import { expect, test } from "bun:test";
import { workspaceBridgeName } from "@agents-in-the-cloud/workspace";
import { privateNetworkFirewallDestinations } from "../src/egress/private-network-firewall.ts";

test("listed hosts become per-bridge private IPv4 firewall entries", async () => {
  const lookups: string[] = [];
  const answers = new Map([["db.internal", ["10.0.0.5", "10.0.0.6", "fd00::5"]], ["public.example", ["93.184.215.14"]], ["docker.internal", ["172.17.0.2"]]]);
  const resolve = async (host: string) => {
    lookups.push(host);
    if (host === "missing.internal") throw new Error("ENOTFOUND");
    return answers.get(host) ?? [host];
  };
  const destinations = await privateNetworkFirewallDestinations(new Map([
    ["alpha001", [{ host: "db.internal", port: 5432 }, { host: "192.168.1.20", port: 22 }, { host: "public.example", port: 443 }, { host: "docker.internal", port: 80 }]],
    ["beta0002", [{ host: "db.internal", port: 6379 }, { host: "missing.internal", port: 80 }]],
  ]), resolve);
  expect(destinations).toEqual([
    { bridge: workspaceBridgeName("alpha001"), address: "10.0.0.5", port: 5432 },
    { bridge: workspaceBridgeName("alpha001"), address: "10.0.0.6", port: 5432 },
    { bridge: workspaceBridgeName("alpha001"), address: "192.168.1.20", port: 22 },
    { bridge: workspaceBridgeName("beta0002"), address: "10.0.0.5", port: 6379 },
    { bridge: workspaceBridgeName("beta0002"), address: "10.0.0.6", port: 6379 },
  ]);
  expect(lookups.filter(host => host === "db.internal")).toHaveLength(1);
});
