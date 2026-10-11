import { registryCredentialSchema } from "../../../packages/shared/src/release-source.ts";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { writeJsonAtomic } from "../../../packages/core/src/fs.ts";
import type { HttpFetcher } from "../../../packages/update/src/server/registry.ts";

export const releaseDockerConfig = "/data/supervisor/docker-auth";
const authSchema = Type.Object({ auths: Type.Object({ "ghcr.io": Type.Optional(Type.Object({ auth: Type.String() })) }) });

export function createReleaseRegistry(directory = releaseDockerConfig) {
  const file = `${directory}/config.json`;
  async function readAuth(): Promise<string | undefined> {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
    const value: unknown = JSON.parse(text);
    if (!Value.Check(authSchema, value)) throw new Error("Invalid private registry configuration");
    return value.auths["ghcr.io"]?.auth;
  }
  return {
    async configured() { return Boolean(await readAuth()); },
    async configure(request: Request) {
      const value: unknown = await request.json();
      if (!Value.Check(registryCredentialSchema, value)) throw new Error("Invalid registry username/token");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeJsonAtomic(file, { auths: { "ghcr.io": { auth: Buffer.from(`${value.username}:${value.token}`).toString("base64") } } }, { mode: 0o600 });
    },
    async clear() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeJsonAtomic(file, { auths: {} }, { mode: 0o600 });
    },
    async fetcher(fetcher: HttpFetcher = fetch): Promise<HttpFetcher> {
      const auth = await readAuth();
      return (input, init = {}) => {
        const url = new URL(String(input));
        const headers = new Headers(init.headers);
        // Credentials are sent only to GHCR's fixed token endpoint, never manifests, dependencies or redirects.
        if (auth && url.origin === "https://ghcr.io" && url.pathname === "/token") headers.set("authorization", `Basic ${auth}`);
        return fetcher(input, { ...init, headers, redirect: url.origin === "https://ghcr.io" && url.pathname === "/token" ? "error" : init.redirect ?? "error" });
      };
    },
  };
}
