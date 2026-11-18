/**
 * The hub client on a phone (m3-design.md section 2), the phone's side of `start.ts`. Not built
 * yet: P2 builds it in wave 1 (the records in expo-secure-store, the hub reached at the address
 * that last worked, then the hub's own list, then an mDNS browse, then the relay; codes from
 * links opened in the app, through expo-linking). Until then the client it starts holds no
 * record and reaches no hub: the app says it is not linked, and linking refuses `notBuilt`
 * (`platform/keys.native.ts`). No code arrives.
 */
import type { RecordStore } from "../platform/client-key";
import { createHubClient } from "./client";
import type { ArrivedCode, StartedClient } from "./start-types";
import { APP_VERSION } from "./version";
import { realTimers } from "./wire";

const unavailable = { ok: false, fault: "unavailable" } as const;

/** Holds nothing: no record is read, and none can be written. */
const noRecords: RecordStore = {
  read: () => Promise.resolve({ ok: true, value: undefined }),
  write: () => Promise.resolve(unavailable),
  update: () => Promise.resolve(unavailable),
  clear: () => Promise.resolve({ ok: true, value: undefined }),
};

export function claimArrivedCode(): ArrivedCode | undefined {
  return undefined;
}

export function onArrivedCode(): () => void {
  return () => undefined;
}

export function startClient(): StartedClient {
  const client = createHubClient({
    // Reaches no hub.
    connect: () => Promise.resolve(undefined),
    records: noRecords,
    timers: realTimers,
    app: APP_VERSION,
  });
  client.start();
  // Wave 0's checks, in a development build only: a release bundle folds `__DEV__` to false
  // before it collects modules, so `dev/wave0.ts` is not in it (docs/spikes/P0-phone-build.md).
  if (__DEV__)
    void import("../dev/wave0").then((wave0) => {
      wave0.startWave0(client);
    });
  return { client };
}
