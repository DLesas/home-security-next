/**
 * The registry module's slice (hub-design.md section 2, module 2; section 6, `devices`): every
 * device with its address, role, name, chip, firmware and state (provisioning, paired,
 * contacted, reset by its owner, removed, left behind by a site move), and the public half of
 * the hub's signing key with its identity (§9), which pairing and mDNS need. Keys are never here:
 * they stay in the shell's `KeyStore` (section 2).
 */
import type { DeviceId } from "../model/ids.ts";
import type { DeviceRow } from "../model/rows.ts";
import type { TimerOf } from "../model/timers.ts";

/** The hub's firmware-signing public key and its identity (§9), as the snapshot gives them. */
export interface HubSigningIdentity {
  /** P-256, X then Y, 64 bytes. */
  readonly signingPublic: Uint8Array;
  /** The first 8 bytes of SHA-256 of `signingPublic`. */
  readonly identity: Uint8Array;
}

export interface RegistrySlice {
  readonly timers: readonly TimerOf<"registry">[];
  /** Every row of `devices`, the hub's own row 0 included, by id. */
  readonly devices: ReadonlyMap<DeviceId, DeviceRow>;
  /**
   * The highest device id ever given in this run or found at start. A new device takes the next
   * one, so an id freed by a refused provisioning is not given again in the same run.
   */
  readonly highestId: number;
  /** Undefined until the shell has made the key pair (section 9, shell/advertise). */
  readonly hub: HubSigningIdentity | undefined;
}

/** The slice before the boot event. */
export const EMPTY_REGISTRY_SLICE: RegistrySlice = {
  timers: [],
  devices: new Map(),
  highestId: 0,
  hub: undefined,
};
