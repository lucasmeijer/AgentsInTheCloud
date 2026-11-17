#!/usr/bin/env bun
import { $ } from "bun";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("..", import.meta.url));
const plugin = async (name: string) => (await $`go tool -n ${name}`.cwd(`${directory}helper`).text()).trim();
const module = "agents-in-the-cloud/workspace-helper";
await $`protoc -I proto --plugin=protoc-gen-go=${await plugin("protoc-gen-go")} --plugin=protoc-gen-go-grpc=${await plugin("protoc-gen-go-grpc")} --go_out=helper --go_opt=module=${module} --go-grpc_out=helper --go-grpc_opt=module=${module} proto/workspace_helper.proto`.cwd(directory);
