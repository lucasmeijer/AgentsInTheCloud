import type { RegistryCredentials } from "@agents-in-the-cloud/shared/release-source";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { HttpFetcher } from "./registry.ts";

const supervisorOrigin = "http://127.0.0.1:3001";

/** The supervisor acknowledges only after routing the app origin to its progress page. */
export async function requestSupervisorUpdate(image: string, fetcher: HttpFetcher = fetch): Promise<void> {
  const response = await fetcher(`${supervisorOrigin}/update`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }),
  });
  if (response.status !== 202) throw new Error((await response.text()).trim() || `Supervisor refused update: ${response.status}`);
}

export async function checkSupervisorRelease(fetcher: HttpFetcher = fetch): Promise<{ digest: string; revision?: string; indexDigest?: string }> {
  const response = await fetcher(`${supervisorOrigin}/release/check`);
  if (!response.ok) throw new Error("Cannot check the configured release source. Check System registry access.");
  const value: unknown = await response.json();
  if (!Value.Check(Type.Object({ digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), revision: Type.Optional(Type.String()), indexDigest: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })) }), value)) throw new Error("Invalid System release response");
  return { digest: value.digest, revision: value.revision, indexDigest: value.indexDigest };
}

export async function prepareSupervisorRelease(reference: string, fetcher: HttpFetcher = fetch): Promise<{ imageId: string; reference: string }> {
  const response = await fetcher(`${supervisorOrigin}/release/prepare`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference }),
  });
  if (!response.ok) throw new Error("Cannot prepare the release. Check System registry access and storage.");
  const value: unknown = await response.json();
  if (!Value.Check(Type.Object({ imageId: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), reference: Type.Literal(reference) }), value)) throw new Error("Invalid prepared release response");
  return { imageId: value.imageId, reference: value.reference };
}

export async function supervisorRegistryRequest(method: "GET" | "POST" | "DELETE", credentials?: RegistryCredentials, fetcher: HttpFetcher = fetch): Promise<{ configured: boolean }> {
  const init: RequestInit = { method };
  if (method === "POST") { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(credentials); }
  const response = await fetcher(`${supervisorOrigin}/release/registry`, init);
  if (!response.ok) throw new Error("Cannot change private registry access. Check System status.");
  return Value.Parse(Type.Object({ configured: Type.Boolean() }), await response.json());
}

export async function requestSupervisorRollback(fetcher: HttpFetcher = fetch): Promise<void> {
  const response = await fetcher(`${supervisorOrigin}/rollback`, { method: "POST" });
  if (response.status !== 202) throw new Error("System cannot roll back. Check the previous image and its workspace dependencies.");
}
