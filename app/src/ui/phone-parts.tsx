/**
 * What the phone's own pages (linking, restoring, scanning, permissions) take from the phone
 * (m3-design.md sections 2 to 4), as one context the phone's shell provides
 * (`shell.native.tsx`). The pages are shared code, rendered by the tests as the web build renders
 * them, so nothing here imports a native module: each piece is an interface, built by its owner.
 *
 * - `scanner`: `platform/scanner.ts`'s `Scanner` (P2's, over expo-camera).
 * - `localNetwork`: `platform/local-network.ts` (this step's).
 * - `linker`: links with a code read on the phone (`hub/finder.ts`'s `readCode`, P2's), whose
 *   secret carries where the code says the hub is (`reach`); reaching it is P2's start
 *   (section 2, "Reaching the hub at home"). `reachFault` gives the two failures the link view
 *   has no words for (section 3).
 * - `restorer`: restore's messages from the phone (section 4; P2's `restoreHub`).
 * - `holdsBackupKey`: whether the phone holds any backup key, which shows "Restore a hub".
 * - `arrived`: codes opened in the app from another app (`hub/start`'s `claimArrivedCode` and
 *   `onArrivedCode`).
 * - `vault` and `reach`: the secure store's last fault and the local network's refusal, which
 *   `phone-notices.tsx` says over every screen.
 * - `homes`: the homes on this phone, their names here, the chosen one (`homes.ts`, M5).
 *
 * The phone's shell builds them from P2's phone client (`phone-wiring.native.ts`); where a piece is
 * not built yet, `stand-ins.tsx`'s, which say so.
 */
import type { LinkRequest, RestoreOffer } from "@hsn/protocol/app";
import { createContext, type ReactNode, useContext } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { CodeSource } from "../hub/client";
import type { ReachState } from "../hub/phone-client";
import type { PhoneLinkSecret, RestoreCode } from "../hub/finder";
import type { RestoreOutcome } from "../hub/restore";
import type { ArrivedCode } from "../hub/start-types";
import type { LocalNetwork } from "../platform/local-network-types";
import type { VaultStatus } from "../platform/vault";
import type { Scanner } from "../platform/scanner";
import type { Homes } from "./homes";

/** Why linking reached no hub, beyond the link view's `unreachable` (section 3). */
export type ReachFault = "localNetworkDenied" | "noHubFound";

export interface PhoneLinker {
  /** Links with a code's secret; the link view (`hub.local`) says how it goes, as for a browser. */
  link(secret: PhoneLinkSecret, from: CodeSource, request: LinkRequest): Promise<void>;
  /** Why the last link reached no hub, when the phone knows: the system refused, or none answered. */
  reachFault(): ReachFault | undefined;
}

/** A restore's offer once it has proved itself, with the home's name on this phone if it has one. */
export interface OfferedRestore {
  readonly offer: RestoreOffer;
  readonly homeName: string | null;
}

export interface PhoneRestorer {
  /**
   * Runs restore's messages for a scanned code (P2's `restoreHub`): `offered` is told the offer
   * before the key is sent, and the outcome says how it ended (`noKey` with the offer when this
   * phone holds no key for it).
   */
  run(code: RestoreCode, offered: (offered: OfferedRestore) => void): Promise<RestoreOutcome>;
}

export interface PhoneArrivals {
  /** The code the app was opened with, once. */
  claim(): ArrivedCode | undefined;
  /** Codes opened in the app while it runs; returns the unsubscribe. */
  subscribe(listener: (code: ArrivedCode) => void): () => void;
}

export interface PhoneParts {
  readonly scanner: Scanner;
  readonly localNetwork: LocalNetwork;
  /** Opens this app's page in the phone's settings (React Native's `Linking.openSettings`). */
  readonly openSettings: () => void;
  readonly linker: PhoneLinker;
  readonly restorer: PhoneRestorer;
  readonly holdsBackupKey: () => Promise<boolean>;
  readonly arrived: PhoneArrivals;
  /** The secure store's last fault (P2's vault), said in words over every screen. */
  readonly vault: StoreApi<VaultStatus>;
  /** What the phone knows of reaching its hub: the system's refusal of the local network. */
  readonly reach: StoreApi<ReachState>;
  /** "ios" or "android": names the phone when it links ("iPhone", "Android phone"). */
  readonly os: "ios" | "android";
  readonly homes: Homes;
}

const PhoneContext = createContext<PhoneParts | undefined>(undefined);

export function PhoneProvider({
  parts,
  children,
}: {
  readonly parts: PhoneParts;
  readonly children: ReactNode;
}) {
  return <PhoneContext.Provider value={parts}>{children}</PhoneContext.Provider>;
}

/** The phone's parts; undefined in a browser, which has none of these pages. */
export function usePhone(): PhoneParts | undefined {
  return useContext(PhoneContext);
}
