#!/usr/bin/env bun
/** Builds the helper into workspace_tools, for the platform the Docker daemon runs workspaces on. */
import { requireDocker } from "@agents-in-the-cloud/core";
import { fileURLToPath } from "node:url";

const tools = fileURLToPath(new URL("../workspace_tools", import.meta.url));
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const platform = (await requireDocker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])).stdout.trim();
// The app image's own stage, so development and releases build it the same way.
const build = Bun.spawn(["docker", "build", "--quiet", "--platform", platform, "--file", `${repository}apps/web/Dockerfile`, "--target", "workspace-helper", "--output", `type=local,dest=${tools}`, repository], { stdout: "inherit", stderr: "inherit" });
if (await build.exited !== 0) throw new Error("Could not build the workspace helper");
