import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { HttpRequestBlockedError, type SecretRequestTransform } from "@agents-in-the-cloud/proxy-egress/server";
import { availableProviderModels, codexAccountId, modelRefValue, type ModelRef, type EnabledModel } from "@agents-in-the-cloud/llm/server";

// Self-describing, non-secret markers survive server restarts without a token registry.
// Every use is checked against the *current* host-side catalogue and authentication.
const markerSchema = Type.Object({
  provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }),
  field: Type.Union([Type.Literal("key"), Type.Literal("account"), Type.Literal("header")]),
  header: Type.Optional(Type.String()),
  // "sk" keeps the real key's `sk-` prefix: Pi classifies OpenAI credentials by it (API key or Sign in with ChatGPT).
  // "anthropic-oauth" keeps `sk-ant-oat`, which tells Pi to sign in as a Claude subscription.
  style: Type.Union([Type.Literal("plain"), Type.Literal("codex"), Type.Literal("sk"), Type.Literal("anthropic-oauth")]),
});
type Marker = Static<typeof markerSchema>;
type Runtime = Pick<ModelRuntime, "getAvailable" | "getModel" | "checkAuth"> & { getAuth(model: Model<Api>): Promise<AuthResult | undefined> };
const markerPattern = /agents-in-the-cloud-pi-([A-Za-z0-9_-]+)-end/g;

function markerToken(marker: Marker): string {
  return `agents-in-the-cloud-pi-${Buffer.from(JSON.stringify(marker)).toString("base64url")}-end`;
}
function placeholder(marker: Marker): string {
  const token = markerToken(marker);
  if (marker.field !== "key") return token;
  if (marker.style === "codex") {
    const claims = { "https://api.openai.com/auth": { chatgpt_account_id: markerToken({ ...marker, field: "account", style: "plain" }) } };
    return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${token}`;
  }
  if (marker.style === "sk") return `sk-${token}`;
  if (marker.style === "anthropic-oauth") return `sk-ant-oat-${token}`;
  return token;
}

function endpoint(model: Model<Api>, auth: AuthResult): URL {
  const source = auth.auth.baseUrl ?? (model.api === "google-vertex" && auth.auth.apiKey && model.baseUrl.includes("{location}") ? "https://aiplatform.googleapis.com" : model.baseUrl);
  const url = new URL(source.replace(/\{([A-Z_]+)\}/g, (_match, name: string) => {
    const value = auth.env?.[name];
    if (!value) throw new Error(`Missing ${name} for ${model.provider}`);
    return encodeURIComponent(value);
  }));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Pi requires an HTTP(S) model endpoint without embedded credentials, query, or fragment: ${model.provider}`);
  }
  return url;
}

function unsupportedAuth(model: Model<Api>, auth: AuthResult): string | undefined {
  if (!auth.auth.apiKey && !Object.keys(auth.auth.headers ?? {}).length && ["bedrock-converse-stream", "google-vertex"].includes(model.api)) {
    return "Pi's workspace bridge requires an API key or bearer token; host AWS credential chains and Google ADC cannot be copied into a workspace.";
  }
  return undefined;
}

export async function piCliModelUnavailableReason(runtime: Runtime, ref: ModelRef): Promise<string | undefined> {
  const model = runtime.getModel(ref.provider, ref.id);
  if (!model) return "Model not found in provider catalog";
  const auth = await runtime.getAuth(model);
  if (!auth) return "Provider not connected";
  return unsupportedAuth(model, auth);
}

export interface PiCliConfiguration {
  auth: Record<string, { type: "api_key"; key: string }>;
  models: { providers: Record<string, { apiKey: string; models: Array<Omit<Model<Api>, "provider">> }> };
  enabledModels: string[];
}

export async function createPiCliConfiguration(runtime: Runtime, enabledModels: EnabledModel[]): Promise<PiCliConfiguration> {
  const result: PiCliConfiguration = { auth: {}, models: { providers: {} }, enabledModels: [] };
  const available = await availableProviderModels(runtime);
  const enabledModelLabels = new Map(enabledModels.map((model) => [modelRefValue(model), model.label]));
  for (const model of available) {
    const auth = await runtime.getAuth(model);
    if (!auth) throw new Error(`Provider disconnected while preparing Pi: ${model.provider}`);
    if (unsupportedAuth(model, auth)) continue;
    const baseUrl = endpoint(model, auth).href.replace(/\/$/, "");
    const style = model.api === "openai-codex-responses" ? "codex"
      : model.api === "anthropic-messages" && auth.auth.apiKey?.includes("sk-ant-oat") ? "anthropic-oauth"
      : auth.auth.apiKey?.startsWith("sk-") ? "sk" : "plain";
    const key = auth.auth.apiKey ? placeholder({ provider: model.provider, model: model.id, field: "key", style }) : "agents-in-the-cloud-pi-no-key";
    const provider = result.models.providers[model.provider] ??= { apiKey: key, models: [] };
    result.auth[model.provider] = { type: "api_key", key: provider.apiKey };
    const headers = Object.fromEntries(Object.keys(auth.auth.headers ?? {}).map((header) => [header,
      placeholder({ provider: model.provider, model: model.id, field: "header", header, style: "plain" }),
    ]));
    const { provider: _provider, ...definition } = model;
    provider.models.push({ ...definition, name: enabledModelLabels.get(modelRefValue(model)) ?? model.name, baseUrl, headers });
  }
  const exported = new Set(Object.entries(result.models.providers).flatMap(([provider, config]) => config.models.map((model) => modelRefValue({ provider, id: model.id }))));
  result.enabledModels = enabledModels.filter((model) => exported.has(modelRefValue(model))).map((model) => `${model.provider}/${model.id}`);
  return result;
}

export async function piCliCredentialHosts(runtime: Runtime): Promise<string[]> {
  const hosts = new Set<string>();
  for (const model of await availableProviderModels(runtime)) {
    const auth = await runtime.getAuth(model);
    if (!auth) throw new Error(`Provider disconnected while resolving Pi endpoints: ${model.provider}`);
    if (!unsupportedAuth(model, auth)) hosts.add(endpoint(model, auth).hostname);
  }
  return [...hosts];
}

export function createPiCliCredentialTransform(getRuntime: () => Promise<Runtime>): SecretRequestTransform {
  return async (request, registerSecret) => {
    const url = new URL(request.url);
    if (url.pathname.match(markerPattern) || url.pathname.includes("agents-in-the-cloud-pi-no-key")) {
      throw new HttpRequestBlockedError("Pi credentials cannot be injected into URL paths");
    }
    const values = [...request.headers.values(), ...[...url.searchParams].flat()];
    if (!values.some((value) => value.match(markerPattern) || value.includes("agents-in-the-cloud-pi-no-key"))) return request;
    const runtime = await getRuntime();
    const resolutions = new Map<string, Promise<{ model: Model<Api>; auth: AuthResult }>>();
    async function resolve(ref: ModelRef) {
      const key = modelRefValue(ref);
      let pending = resolutions.get(key);
      if (!pending) {
        pending = (async () => {
          const model = runtime.getModel(ref.provider, ref.id);
          if (!model) throw new HttpRequestBlockedError("Pi model is no longer configured in AgentsInTheCloud");
          const auth = await runtime.getAuth(model);
          if (!auth) throw new HttpRequestBlockedError("Pi provider is no longer connected in AgentsInTheCloud");
          const unsupported = unsupportedAuth(model, auth);
          if (unsupported) throw new HttpRequestBlockedError(unsupported);
          return { model, auth };
        })();
        resolutions.set(key, pending);
      }
      return pending;
    }
    let subscription = false;
    async function replace(value: string): Promise<string> {
      for (const match of value.matchAll(markerPattern)) {
        let marker: Marker;
        try { marker = Value.Parse(markerSchema, JSON.parse(Buffer.from(match[1]!, "base64url").toString())); }
        catch { throw new HttpRequestBlockedError("Invalid Pi credential placeholder"); }
        const { model, auth } = await resolve({ provider: marker.provider, id: marker.model });
        const candidates = marker.field === "header" ? [model] : await availableProviderModels(runtime, marker.provider);
        const allowed = candidates.some((candidate) => endpoint(candidate, auth).origin === url.origin);
        if (!allowed) throw new HttpRequestBlockedError(`Pi credentials are not allowed for ${url.origin}`);
        let replacement: string | null | undefined;
        if (marker.style === "anthropic-oauth") subscription = true;
        if (marker.field === "key") replacement = auth.auth.apiKey;
        else if (marker.field === "header") replacement = auth.auth.headers?.[marker.header!];
        else {
          if (model.api !== "openai-codex-responses") throw new HttpRequestBlockedError("Pi account placeholders are only valid for Codex models");
          try {
            replacement = codexAccountId(auth.auth.apiKey!);
          } catch {
            throw new HttpRequestBlockedError("Could not resolve the Pi Codex account; reconnect the provider in AgentsInTheCloud");
          }
        }
        if (replacement === undefined) throw new HttpRequestBlockedError("Pi authentication changed; launch a new Pi tab to refresh its configuration");
        const expected = placeholder(marker);
        if (!value.includes(expected)) throw new HttpRequestBlockedError("Malformed Pi credential placeholder");
        if (replacement) registerSecret(replacement);
        value = value.replaceAll(expected, replacement ?? "");
      }
      return value;
    }
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (value.includes("agents-in-the-cloud-pi-no-key")) continue;
      const replaced = await replace(value);
      if (replaced) headers.set(name, replaced);
    }
    if (subscription) {
      headers.delete("x-app");
      headers.set("user-agent", "pi");
    }
    const query = new URLSearchParams();
    for (const [name, value] of url.searchParams) query.append(await replace(name), await replace(value));
    url.search = query.toString();
    const init: RequestInit & { duplex: "half" } = { method: request.method, headers, body: request.body, duplex: "half" };
    return new Request(url, init);
  };
}
