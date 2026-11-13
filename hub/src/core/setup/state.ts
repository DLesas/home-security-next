/**
 * The setup module's slice (hub-design.md section 2, module 4; section 9, "Adding a device over
 * USB"; protocol.md §10): each USB link with the board's latest Identity and the exchange in
 * progress on it, and what pairing data needs from the site.
 */
import type { SetupMessage, SetupType } from "@hsn/protocol";
import type { DeviceId, LinkId, RequestId } from "../model/ids.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** A decoded Identity setup message (§10). */
export type Identity = Extract<SetupMessage, { readonly type: typeof SetupType.Identity }>;

/** Who asked for an exchange: a person through the CLI, or the automatic add (D100). */
export type Asker =
  | { readonly kind: "command"; readonly request: RequestId; readonly actor: string }
  | { readonly kind: "automatic" };

/** What a USB link is waiting for. */
export type Exchange =
  /** Set role was sent (§10); the Identity that answers it shows whether the role was taken. */
  | {
      readonly kind: "setRole";
      readonly asker: Asker;
      readonly name: string;
      readonly role: number;
      readonly deadline: Mono;
    }
  /**
   * Provision was sent for `device`. `deadline` is undefined once the 5 s ‡ have passed and the
   * asker was told; a late result is still taken.
   */
  | {
      readonly kind: "provision";
      readonly asker: Asker;
      readonly device: DeviceId;
      readonly deadline: Mono | undefined;
      /**
       * The board's Identity said it was paired to this hub when Provision was sent, so it may
       * hold this device's key from an earlier attempt: a refusal then keeps the rows (PR2).
       */
      readonly mayHoldKey: boolean;
    };

/** One open USB link (section 3). */
export interface UsbBoard {
  readonly link: LinkId;
  /** The serial port's path, as `hsn usb list` shows it. */
  readonly label: string;
  /** The board's latest Identity; undefined until one arrives, and again after an Erase. */
  readonly identity: Identity | undefined;
  readonly exchange: Exchange | undefined;
}

/**
 * What pairing data takes from the site (§9): its channel (null until chosen, section 8), the
 * data rates allowed, and the Wi-Fi details.
 */
export interface SitePairing {
  readonly channel: number | null;
  readonly rateMask: number;
  readonly wifiName: Uint8Array;
  readonly wifiPassword: Uint8Array;
}

export interface SetupSlice {
  readonly timers: readonly TimerOf<"setup">[];
  readonly boards: ReadonlyMap<LinkId, UsbBoard>;
  /**
   * The key of each device still provisioning in this run, so that a retry sends the same
   * address and key (section 9). SPEC-QUESTION: section 2 says keys never enter the state,
   * except once in a written-now `StoreOp` and the Provision message, yet section 9 asks a retry
   * to send the same key, which the core can then only take from here. A key is held only while
   * its device is provisioning, never put in a record, a reply or any effect but those two, and
   * dropped when the device is paired, refused or removed. After a restart they come from the
   * snapshot's `provisioningKeys`, so a retry sends the same key then too.
   */
  readonly retryKeys: ReadonlyMap<DeviceId, Uint8Array>;
}

/** The slice before the boot event. */
export const EMPTY_SETUP_SLICE: SetupSlice = {
  timers: [],
  boards: new Map(),
  retryKeys: new Map(),
};
