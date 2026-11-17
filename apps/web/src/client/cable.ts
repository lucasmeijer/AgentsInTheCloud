/// <reference lib="dom" />

import { decodeCableServerMessage, liveRegionDigestsSchema, liveShownAttribute, serializeCableIdentifier, type AgentsInTheCloudCableClient, type CableClientMessage, type CableIdentifier, type CableSubscription, type CableSubscriptionOptions, type WorkspaceVisibilityReport } from "@agents-in-the-cloud/shared";
import { Value } from "typebox/value";

declare global {
  interface Window {
    AgentsInTheCloudCable?: AgentsInTheCloudCableClient;
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

type SubscriptionLease = CableSubscription & {
  options?: CableSubscriptionOptions;
};

type DesiredSubscription = {
  identifier: CableIdentifier;
  leases: Set<SubscriptionLease>;
  status: "pending" | "ready" | "rejected";
  subscriptionId?: string;
};

/** A live region the page shows: the element it was applied to, and the digest of its markup. */
type ShownRegion = { element: WeakRef<Element>; digest: string };

export type CableStreamRenderer = (html: string, isCurrent: () => boolean, onApplied: () => void, onRegion: (target: string, digest: string | undefined) => void) => void;

export function createAgentsInTheCloudCableClient(renderStreams: CableStreamRenderer): AgentsInTheCloudCableClient {
  const desired = new Map<string, DesiredSubscription>();
  // What each channel's regions on the page show, kept across unsubscribing so that subscribing
  // again (switching back to a workspace, reconnecting) only receives regions that changed.
  const shownRegions = new Map<string, Map<string, ShownRegion>>();

  /** Subscriptions to one channel that differ only in parameters, like a workspace surface's selection, render the same regions. */
  function shownRegionsKey(identifier: CableIdentifier): string {
    return serializeCableIdentifier(identifier.channel === "module" ? { ...identifier, params: {} } : identifier);
  }

  function showRegion(identifier: CableIdentifier, target: string, digest: string | undefined): void {
    const key = shownRegionsKey(identifier);
    let regions = shownRegions.get(key);
    const element = document.getElementById(target);
    if (!digest || !element) { regions?.delete(target); return; }
    if (!regions) shownRegions.set(key, regions = new Map());
    regions.set(target, { element: new WeakRef(element), digest });
  }

  /** Regions still in the page as they were applied: a target whose element was replaced or removed shows something else. */
  function shownDigests(identifier: CableIdentifier): Record<string, string> | undefined {
    const regions = shownRegions.get(shownRegionsKey(identifier));
    if (!regions) return undefined;
    const digests: Record<string, string> = {};
    for (const [target, region] of regions) {
      const element = region.element.deref();
      if (element?.isConnected && document.getElementById(target) === element) digests[target] = region.digest;
      else regions.delete(target);
    }
    return Object.keys(digests).length ? digests : undefined;
  }
  const delays = [100, 250, 500, 1000, 2000, 5000];
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let recovering = true;
  let closingForPageHide = false;
  let visibility: WorkspaceVisibilityReport = { surfaceKeys: [] };
  let lastMessageAt = Date.now();
  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 75_000) socket.close();
  }, 15_000);

  function cableUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/cable`;
  }

  function changed(): void { document.dispatchEvent(new Event("live:connection")); }

  function sendRaw(message: CableClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function subscribeOnWire(subscription: DesiredSubscription): void {
    const subscriptionId = crypto.randomUUID();
    subscription.status = "pending";
    subscription.subscriptionId = subscriptionId;
    changed();
    const message: Extract<CableClientMessage, { command: "subscribe" }> = { command: "subscribe", identifier: subscription.identifier, subscriptionId };
    const shown = shownDigests(subscription.identifier);
    if (shown) message.shown = shown;
    sendRaw(message);
  }

  function resubscribeAll(): void {
    for (const subscription of desired.values()) subscribeOnWire(subscription);
  }

  function scheduleReconnect(): void {
    if (closingForPageHide || reconnectTimer) return;
    const delay = delays[Math.min(attempts++, delays.length - 1)]!;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function matchingSubscription(identifier: CableIdentifier, subscriptionId: string): DesiredSubscription | undefined {
    const subscription = desired.get(serializeCableIdentifier(identifier));
    return subscription?.subscriptionId === subscriptionId ? subscription : undefined;
  }

  function markSubscriptionsDisconnected(notify: boolean): void {
    for (const subscription of desired.values()) {
      if (notify && subscription.status === "ready") {
        for (const lease of subscription.leases) lease.options?.onDisconnected?.();
      }
      subscription.status = "pending";
      subscription.subscriptionId = undefined;
    }
  }

  /** Applies a subscription's streams while it stays current, noting the regions they show. */
  function render(html: string, message: { identifier: CableIdentifier; subscriptionId: string }, subscription: DesiredSubscription, onApplied: () => void): void {
    const isCurrent = () => matchingSubscription(message.identifier, message.subscriptionId) === subscription;
    renderStreams(html, isCurrent, onApplied, (target, digest) => showRegion(message.identifier, target, digest));
  }

  function handleMessage(source: WebSocket, event: MessageEvent): void {
    if (socket !== source) return;
    lastMessageAt = Date.now();
    const message = decodeCableServerMessage(String(event.data));
    switch (message.type) {
      case "welcome":
        attempts = 0;
        sendRaw({ command: "visibility", visibility });
        resubscribeAll();
        break;
      case "confirm_subscription": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (!subscription) break;
        const applied = () => {
          if (matchingSubscription(message.identifier, message.subscriptionId) !== subscription) return;
          subscription.status = "ready";
          if ([...desired.values()].every(item => item.status !== "pending")) recovering = false;
          changed();
          for (const lease of subscription.leases) lease.options?.onReady?.();
        };
        if (message.html) render(message.html, message, subscription, applied);
        else applied();
        break;
      }
      case "reject_subscription":
        const rejected = matchingSubscription(message.identifier, message.subscriptionId);
        if (rejected) {
          rejected.status = "rejected";
          rejected.subscriptionId = undefined;
          console.error("Cable subscription rejected", message);
          for (const lease of rejected.leases) lease.options?.onRejected?.(message.reason);
          if ([...desired.values()].every(item => item.status !== "pending")) recovering = false;
          changed();
        }
        break;
      case "turbo_stream": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (subscription) render(message.html, message, subscription, () => {});
        break;
      }
      case "ping":
        sendRaw({ command: "pong", time: message.time });
        break;
      case "error":
        console.error("Cable error", message.message);
        break;
    }
  }

  function connect(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    lastMessageAt = Date.now();
    const connecting = new WebSocket(cableUrl());
    socket = connecting;
    connecting.onmessage = (event) => handleMessage(connecting, event);
    connecting.onclose = () => {
      if (socket !== connecting) return;
      socket = undefined;
      recovering = true;
      if (!closingForPageHide) markSubscriptionsDisconnected(true);
      changed();
      scheduleReconnect();
    };
    connecting.onerror = () => connecting.close();
  }

  window.addEventListener("pagehide", () => {
    closingForPageHide = true;
    recovering = true;
    markSubscriptionsDisconnected(false);
    socket?.close();
  });
  window.addEventListener("pageshow", () => {
    closingForPageHide = false;
    if (desired.size > 0) connect();
  });

  const client: AgentsInTheCloudCableClient = {
    ready() { return socket?.readyState === WebSocket.OPEN && !recovering; },
    reconnect() { socket?.close(); },
    reportVisibility(next) {
      visibility = next;
      sendRaw({ command: "visibility", visibility });
    },
    subscribe(identifier, options) {
      const key = serializeCableIdentifier(identifier);
      const shownIn = options?.shownIn;
      const shown = shownIn?.getAttribute(liveShownAttribute);
      if (shownIn && shown) {
        for (const [target, digest] of Object.entries(Value.Parse(liveRegionDigestsSchema, JSON.parse(shown)))) showRegion(identifier, target, digest);
        shownIn.removeAttribute(liveShownAttribute);
      }
      let subscription = desired.get(key);
      if (!subscription) {
        subscription = { identifier, leases: new Set(), status: "pending" };
        desired.set(key, subscription);
        closingForPageHide = false;
        connect();
        if (socket?.readyState === WebSocket.OPEN) subscribeOnWire(subscription);
      } else if (subscription.status === "rejected" && socket?.readyState === WebSocket.OPEN) {
        subscribeOnWire(subscription);
      }

      const lease: SubscriptionLease = {
        options,
        unsubscribe() {
          if (!subscription.leases.delete(lease) || subscription.leases.size > 0) return;
          if (desired.get(key) !== subscription) return;
          desired.delete(key);
          if ([...desired.values()].every(item => item.status !== "pending")) recovering = false;
          changed();
          if (subscription.subscriptionId) {
            sendRaw({ command: "unsubscribe", identifier: subscription.identifier, subscriptionId: subscription.subscriptionId });
          }
        },
      };
      subscription.leases.add(lease);
      if (subscription.status === "ready") requestAnimationFrame(() => {
        if (subscription.leases.has(lease) && desired.get(key) === subscription && subscription.status === "ready") lease.options?.onReady?.();
      });
      return lease;
    },
  };

  return client;
}
