#!/usr/bin/env bun
/** Builds the helper into workspace_tools, for the platform the Docker daemon runs workspaces on. */
import { requireDocker } from "@agents-in-the-cloud/core";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("..", import.meta.url));
const platform = (await requireDocker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])).stdout.trim();
const build = Bun.spawn(["docker", "build", "--quiet", "--platform", platform, "--output", `type=local,dest=${directory}workspace_tools`, directory], { stdout: "inherit", stderr: "inherit" });
if (await build.exited !== 0) throw new Error("Could not build the workspace helper");
