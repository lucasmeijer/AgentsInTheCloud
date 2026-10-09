Idiomatic tailscale + hetzner / vps install of AgentsInTheCloud.

These instructions are intended for to be executed by a coding agent on behalf of a user that wants to install AgentsInTheCloud.

The user needs to rent/have a VPS on hetzner or digital ocean or anywhere else.

These instructions are written in a linux distribution agnostic way on purpose.

This installation option assumes AgentsInTheCloud has this entire computer to itself.

AgentsInTheCloud offers no authentication or security mechanism.

It's the coding agent and human's job to ensure only the people that are allowed to access the computer can access that computer.

The recommended way to do this is to install tailscale on it, and add it to your tailscale network. Give the node a good identifiable name like 'agents-in-the-cloud'. Have the agent start Tailscale login with that hostname. If Tailscale prints an authentication URL, the agent must stop and ask the human driving the install to open that URL and approve the node in the tailnet. After the human confirms, the agent should verify that `tailscale status` shows the node is authenticated and that the node is reachable through Tailscale/MagicDNS. If the human provides a Tailscale auth key instead, the agent may use that for non-interactive authentication.

Do not proceed with starting agents-in-the-cloud until tailscale is properly working. Again, you might have to ask the user to intervene, you do not have to
accomplish everything in this document in a single turn.

Do not lock down public SSH or HTTP until Tailscale access has been verified from the human's machine. Once verified, lock down the machine for any other incoming traffic.

Once tailscale install has been established, and the machine is locked down from other traffic, proceed to installing and running agents-in-the-cloud itself:

Add an 'agents-in-the-cloud' user with sudo powers.
Install agents-in-the-cloud system dependencies: docker, docker buildx, bun, git, git lfs, unzip.
Install Bun in a way that makes `bun` available to the `agents-in-the-cloud` user in both interactive shells and the boot-time service. Prefer an OS/package-manager install when available. If using Bun's official curl installer, ensure its prerequisites such as `unzip` are installed, and make sure the service PATH includes the Bun install directory. Verify the install with `sudo -u agents-in-the-cloud bun --version`; if that fails, Bun is not installed correctly for AgentsInTheCloud.

Then as agents-in-the-cloud user, git clone https://github.com/lucasmeijer/atelier into ~/agents-in-the-cloud.
Ensure that on every boot "bun install && bun run web" gets run from the agents-in-the-cloud folder.
Start agents-in-the-cloud the same way the next boot would, and monitor the logs for any startup problems.
AgentsInTheCloud by default starts on 0.0.0.0:3000 which is fine for production.

You can now access agents-in-the-cloud from anywhere on your tailnet through http://agents-in-the-cloud:3000

The in-browser onboarding experience will ask the user for some credentials. Let the user do these steps herself, the coding agents job is completed at this point.