import { Type } from "typebox";
import { Value } from "typebox/value";
import type { HttpFetcher } from "./registry.ts";

const supervisorOrigin = "http://127.0.0.1:3001";

export async function requestSupervisorUpdate(image: string, fetcher: HttpFetcher = fetch): Promise<void> {
  const response = await fetcher(`${supervisorOrigin}/update`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }),
  });
  if (response.status !== 202) throw new Error((await response.text()).trim() || `Supervisor refused update: ${response.status}`);
}

export async function readSystemVersion(fetcher: HttpFetcher = fetch): Promise<number> {
  const response = await fetcher(`${supervisorOrigin}/status`);
  if (!response.ok) throw new Error(`Supervisor status failed: ${response.status}`);
  return Value.Parse(Type.Object({ systemVersion: Type.Optional(Type.Integer({ minimum: 0 })) }), await response.json()).systemVersion ?? 0;
}
