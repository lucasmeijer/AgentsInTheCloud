import { createProcessFileLock, readTextIfExists, writeJsonAtomic, type JsonValue } from "@agents-in-the-cloud/core";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const adminScopes = ["configuration", "secrets", "workspaces", "workspaces:force-delete", "host:read", "security"] as const;
export type AdminScope = typeof adminScopes[number];
const scopeSchema = Type.Union(adminScopes.map(scope => Type.Literal(scope)));
export const bindingSchema = Type.Object({
  host: Type.String(), port: Type.Integer({ minimum: 1024, maximum: 65535 }),
  tls: Type.Optional(Type.Object({ cert: Type.String(), key: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
export const tokenInputSchema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), scopes: Type.Array(scopeSchema, { minItems: 1, uniqueItems: true }), expiresAt: Type.Optional(Type.String()) }, { additionalProperties: false });
const tokenSchema = Type.Object({ id: Type.String(), name: Type.String(), scopes: Type.Array(scopeSchema), hash: Type.String({ pattern: "^[a-f0-9]{64}$" }), createdAt: Type.String(), expiresAt: Type.Optional(Type.String()) }, { additionalProperties: false });
const storeSchema = Type.Object({ bindings: Type.Array(bindingSchema), tokens: Type.Array(tokenSchema) }, { additionalProperties: false });
export type AdminBinding = { host: string; port: number; tls?: { cert: string; key: string } };
export type AdminTokenInput = { name: string; scopes: AdminScope[]; expiresAt?: string };
export type AdminToken = AdminTokenInput & { id: string; hash: string; createdAt: string };
export type AdminConfiguration = { bindings: AdminBinding[]; tokens: AdminToken[] };

export function validateBindings(value: JsonValue): AdminBinding[] {
  if (!Value.Check(Type.Array(bindingSchema), value)) throw new Error("Invalid admin bindings");
  const addresses = new Set<string>();
  for (const binding of value) {
    if (!isIP(binding.host)) throw new Error("Admin bind host must be an explicit IPv4 or IPv6 address");
    if ([2999, 3000, 3001, 3080, 24800].includes(binding.port) || (binding.port >= 41000 && binding.port <= 41999)) throw new Error("Invalid admin bindings: reserved service port");
    const loopback = binding.host === "::1" || binding.host.startsWith("127.");
    if (!loopback && !binding.tls) throw new Error("Non-loopback admin bindings require TLS");
    if (binding.tls && (!isAbsolute(binding.tls.cert) || !isAbsolute(binding.tls.key))) throw new Error("TLS certificate and key paths must be absolute");
    const address = `${binding.host}:${binding.port}`;
    if (addresses.has(address)) throw new Error("Duplicate admin binding");
    addresses.add(address);
  }
  return value;
}

const hashToken = (secret: string) => createHash("sha256").update(secret).digest("hex");
export function publicToken({ hash: _hash, ...token }: AdminToken) { return token; }

export function createAdminStore(path: string) {
  const lock = createProcessFileLock({ lockDir: () => `${path}.lock`, label: "admin configuration" });
  async function read(): Promise<AdminConfiguration> {
    const text = await readTextIfExists(path);
    if (text === undefined) return { bindings: [], tokens: [] };
    const value: JsonValue = JSON.parse(text);
    if (!Value.Check(storeSchema, value)) throw new Error("Invalid admin configuration file");
    validateBindings(value.bindings);
    if (value.tokens.some(token => token.expiresAt !== undefined && !Number.isFinite(Date.parse(token.expiresAt)))) throw new Error("Invalid stored token expiry");
    return value;
  }
  async function update<T>(change: (config: AdminConfiguration) => T): Promise<T> {
    return lock(async () => {
      const config = await read();
      const result = change(config);
      await writeJsonAtomic(path, config, { mode: 0o600 });
      return result;
    });
  }
  return {
    read,
    async setBindings(value: JsonValue) {
      const bindings = validateBindings(value);
      return update(config => { config.bindings = bindings; return { bindings, restartRequired: true }; });
    },
    async issue(value: JsonValue) {
      if (!Value.Check(tokenInputSchema, value)) throw new Error("Invalid token name, scopes or expiry");
      if (value.expiresAt !== undefined && (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now())) throw new Error("Token expiry must be a future timestamp");
      const secret = `aitc_admin_${randomBytes(32).toString("base64url")}`;
      const token: AdminToken = { ...value, id: crypto.randomUUID(), createdAt: new Date().toISOString(), hash: hashToken(secret) };
      return update(config => { config.tokens.push(token); return { token: publicToken(token), secret }; });
    },
    async revoke(id: string) {
      return update(config => {
        const index = config.tokens.findIndex(token => token.id === id);
        if (index < 0) return false;
        config.tokens.splice(index, 1);
        return true;
      });
    },
    async authenticate(authorization: string | null) {
      const match = /^Bearer (aitc_admin_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? "");
      if (!match) return undefined;
      const hash = Buffer.from(hashToken(match[1]!), "hex");
      return (await read()).tokens.find(token => timingSafeEqual(hash, Buffer.from(token.hash, "hex")) && (token.expiresAt === undefined || Date.parse(token.expiresAt) > Date.now()));
    },
  };
}
export type AdminStore = ReturnType<typeof createAdminStore>;
