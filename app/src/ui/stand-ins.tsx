/**
 * The phone's parts (`phone-parts.tsx`) where the phone client gives none (a preview, or before it
 * has started), and the camera, which no one has built yet, each saying plainly what it is:
 *
 * - **Scanner**: no camera ("This phone has no camera to scan with"), so the camera screen offers
 *   the typed code; P2's is expo-camera's behind the same `Scanner`.
 * - **Linker**: the hub client's own `link` with the code's secret, which carries where the code
 *   says the hub is (`reach`, P2's `finder.ts`); the phone's start reaches it there (P2's). It
 *   knows no `reachFault`.
 * - **Restorer**: reaches no hub (`unreachable`). **Backup keys**: none held. **Vault** and
 *   **reach**: nothing wrong.
 *
 * The local network permission (`platform/local-network`), the phone's settings page and the codes
 * opened in the app (`hub/start`) are real. A development build's preview (`preview.ts`) may put
 * other parts in their place, to show each page.
 */
import { Linking, Platform, View } from "react-native";
import { createStore } from "zustand/vanilla";
import type { ReachState } from "../hub/phone-client";
import type { VaultStatus } from "../platform/vault";
import type { HubClient } from "../hub/client";
import { claimArrivedCode, onArrivedCode } from "../hub/start";
import { ask, permission } from "../platform/local-network";
import type { Scanner } from "../platform/scanner";
import type { PhoneParts } from "./phone-parts";
import { NO_HOMES } from "./homes";

const UNDETERMINED = { state: "undetermined", canAskAgain: true } as const;

/** A scanner with no camera: what the iOS simulator has, and every phone until P2's is built. */
export const NO_CAMERA: Scanner = {
  available: () => Promise.resolve(false),
  permission: () => Promise.resolve(UNDETERMINED),
  ask: () => Promise.resolve({ state: "denied", canAskAgain: false }),
  View: () => <View className="flex-1" />,
};

export function standInPhoneParts(hub: HubClient): PhoneParts {
  return {
    scanner: NO_CAMERA,
    localNetwork: { permission, ask },
    openSettings: () => {
      void Linking.openSettings();
    },
    linker: {
      link: (secret, from, request) => hub.link(secret, from, request),
      reachFault: () => undefined,
    },
    // Reaches no new hub until P2's `restoreHub` is given its connection here.
    restorer: { run: () => Promise.resolve({ ok: false, fault: "unreachable" }) },
    holdsBackupKey: () => Promise.resolve(false),
    arrived: { claim: claimArrivedCode, subscribe: onArrivedCode },
    vault: createStore<VaultStatus>()(() => ({ fault: null, identity: null })),
    reach: createStore<ReachState>()(() => ({
      localNetworkDenied: false,
      browse: null,
      path: null,
      relayClosed: null,
    })),
    os: Platform.OS === "ios" ? "ios" : "android",
    homes: NO_HOMES,
  };
}

/** Parts a development build's preview puts in place of these (`preview.ts`); else none. */
let override: ((hub: HubClient) => PhoneParts) | undefined;

export function overridePhoneParts(make: (hub: HubClient) => PhoneParts): void {
  override = make;
}

/**
 * The parts the phone's shell gives its pages: a preview's, else the phone client's (`live`,
 * undefined before it has started), else these stand-ins.
 */
export function phonePartsFor(
  hub: HubClient,
  live: (hub: HubClient) => PhoneParts | undefined,
): PhoneParts {
  return override?.(hub) ?? live(hub) ?? standInPhoneParts(hub);
}
