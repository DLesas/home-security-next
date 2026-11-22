/**
 * The hub client in a browser (m2-design.md section 8), the web build's side of `start.ts`: the
 * page's own origin for the channel, IndexedDB for the record, Web Locks and a BroadcastChannel
 * between tabs (spike K1).
 *
 * The code the page was opened with (m2-design.md section 5) is taken out of the address when
 * this file loads, the app's very first step, before the router or any screen loads
 * (`src/entry.ts` imports this first), and kept here, in memory only, until the root layout links
 * with it.
 */
import { APP_PROTO_LATEST } from "@hsn/protocol/app";
import { createHubClient, type HubClientDeps } from "./client";
import { takeCodeFromAddress } from "./fragment";
import { indexedDbRecordStore } from "../platform/keys.web";
import type { ArrivedCode, StartedClient } from "./start-types";
import { TAB_CHANNEL } from "./tabs";
import { APP_VERSION } from "./version";
import { channelOrigin, realTimers, webSocketConnect } from "./wire";

function tabId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The code the page was opened with, taken out of the address. */
function takeArrivedCode(): ArrivedCode | undefined {
  return typeof window === "undefined"
    ? undefined
    : takeCodeFromAddress(window.location, window.history);
}

let arrived: ArrivedCode | undefined = takeArrivedCode();

/** The code, once: after this the secret is held only by the linking call. */
export function claimArrivedCode(): ArrivedCode | undefined {
  const code = arrived;
  arrived = undefined;
  return code;
}

/** A browser is given a code only with the page: nothing arrives later. */
export function onArrivedCode(): () => void {
  return () => undefined;
}

/** Builds the matching client for the hub serving this web build (m3-design.md section 3). */
export function createWebHubClient(deps: Omit<HubClientDeps, "proto">) {
  return createHubClient({ ...deps, proto: [APP_PROTO_LATEST, APP_PROTO_LATEST] });
}

export function startClient(): StartedClient {
  const locks = typeof navigator.locks === "object" ? navigator.locks : undefined;
  const client = createWebHubClient({
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
