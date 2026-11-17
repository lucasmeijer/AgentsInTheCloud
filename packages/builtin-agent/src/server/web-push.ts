import { getWorkspaceInit, getWorkspaceTitle } from "@agents-in-the-cloud/workspace";
import { isGitWorkspaceTemplateInit } from "@agents-in-the-cloud/workspace-templates";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import webPush, { type PushSubscription } from "web-push";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";

const vapidSchema = Type.Object({ publicKey: Type.String(), privateKey: Type.String() });
let keys: Promise<webPush.VapidKeys> | undefined;

function vapidKeys(): Promise<webPush.VapidKeys> {
  return keys ??= (async () => {
    const directory = getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir;
    const path = join(directory, "web-push-vapid.json");
    if (await Bun.file(path).exists()) return Value.Parse(vapidSchema, JSON.parse(await readFile(path, "utf8")));
    const generated = webPush.generateVAPIDKeys();
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify(generated), { mode: 0o600, flag: "wx" });
    return generated;
  })();
}

export async function pushPublicKey(): Promise<string> { return (await vapidKeys()).publicKey; }

const subscriptionSchema = Type.Object({
  endpoint: Type.String({ maxLength: 4096 }),
  keys: Type.Object({ p256dh: Type.String(), auth: Type.String() }),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Browser subscription JSON is validated at this input boundary.
export function parsePushSubscription(value: unknown): PushSubscription {
  if (!Value.Check(subscriptionSchema, value)) throw new Error("Invalid push subscription");
  const url = new URL(value.endpoint);
  const trustedHost = url.hostname === "web.push.apple.com"
    || url.hostname.endsWith(".push.apple.com")
    || url.hostname === "fcm.googleapis.com"
    || url.hostname === "updates.push.services.mozilla.com"
    || url.hostname.endsWith(".notify.windows.com");
  if (url.protocol !== "https:" || url.port || url.username || url.password || !trustedHost) throw new Error("Unsupported push service");
  if (!/^[\w-]+$/.test(value.keys.p256dh) || Buffer.from(value.keys.p256dh, "base64url").length !== 65
    || !/^[\w-]+$/.test(value.keys.auth) || Buffer.from(value.keys.auth, "base64url").length !== 16) throw new Error("Invalid push subscription keys");
  return value;
}

export async function sendTurnNotification(ctx: AgentRenderContext, subscription: PushSubscription): Promise<void> {
  const vapid = await vapidKeys();
  const title = await getWorkspaceTitle(ctx.workspaceId);
  const init = title ? undefined : await getWorkspaceInit(ctx.workspaceId);
  const workspaceName = title || (isGitWorkspaceTemplateInit(init) ? init.name : undefined) || `Workspace ${ctx.workspaceId}`;
  try {
    await webPush.sendNotification(subscription, JSON.stringify({
      title: `${workspaceName} is ready`,
      url: `/workspaces/${encodeURIComponent(ctx.workspaceId)}?agent=${encodeURIComponent(ctx.agentId)}`,
      tag: `agent-turn:${ctx.workspaceId}:${ctx.agentId}`,
    }), {
      vapidDetails: { subject: "https://github.com/lucasmeijer/atelier", ...vapid },
      TTL: 60 * 60,
      urgency: "high",
      timeout: 15_000,
    });
  } catch (error) {
    // Expired/revoked browser subscriptions are expected external input. The
    // one-shot intent has already been consumed; never carry it into a new turn.
    if (error instanceof webPush.WebPushError && (error.statusCode === 404 || error.statusCode === 410)) return;
    throw error;
  }
}
