/**
 * The hub client in a browser (m2-design.md section 8): the page's own origin for the channel,
 * IndexedDB for the record, Web Locks and a BroadcastChannel between tabs (spike K1). A code in
 * the address is taken out of it before anything else runs.
 */
import { type ArrivedCode, takeCodeFromAddress } from "./fragment";
import { createHubClient, type HubClient } from "./client";
import { indexedDbRecordStore } from "../platform/keys.web";
import { TAB_CHANNEL } from "./tabs";
import { APP_VERSION } from "./version";
import { channelOrigin, realTimers, webSocketConnect } from "./wire";

function tabId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface BrowserClient {
  readonly client: HubClient;
}

/** The code the page was opened with, taken out of the address; called once, as the app loads. */
export function takeArrivedCode(): ArrivedCode | undefined {
  return typeof window === "undefined"
    ? undefined
    : takeCodeFromAddress(window.location, window.history);
}

export function startBrowserClient(): BrowserClient {
  const locks = typeof navigator.locks === "object" ? navigator.locks : undefined;
  const client = createHubClient({
    connect: webSocketConnect(channelOrigin(window.location)),
    records: indexedDbRecordStore(),
    timers: realTimers,
    app: APP_VERSION,
    ...(locks === undefined || typeof BroadcastChannel !== "function"
      ? {}
      : { tabs: { id: tabId(), locks, bus: new BroadcastChannel(TAB_CHANNEL) } }),
  });
  client.start();
  // The page going closes its session at once, so another tab's takes over without waiting.
  window.addEventListener("pagehide", () => {
    client.stop();
  });
  return { client };
}
