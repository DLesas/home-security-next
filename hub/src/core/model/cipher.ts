/**
 * The deterministic cipher the core opens and seals packets through (hub-design.md sections 2
 * and 3). It is a port: the shell implements it over `@hsn/protocol`'s `sealPacket` and
 * `openPacket` with keys from the `KeyStore`, and tests key it from the vector files. It is
 * declared here because `CoreDeps` carries it and the core may import only its model; `ports/`
 * re-exports it.
 */
import type { Result } from "neverthrow";
import type {
  Direction,
  MaxPacketLength,
  Message,
  OpenedPacket,
  ProtocolError,
} from "@hsn/protocol";
import type { HubError } from "./errors.ts";
import type { DeviceId } from "./ids.ts";

export interface SealRequest {
  readonly direction: Direction;
  /**
   * The device's address, as the packet's clear header carries it. SPEC-QUESTION: section 3's
   * sketch gives the cipher only the device id; `sealPacket` needs the address too, and the
   * core holds it (registry), so it is passed here.
   */
  readonly address: number;
  readonly counter: number;
  readonly binding: Uint8Array;
  readonly maxLength: MaxPacketLength;
  /**
   * Which of the device's keys to seal under (D141, m3-updates-design section 7): a Key change is
   * sealed under the current (old) key; absent is `current`.
   */
  readonly key?: KeyUsed;
}

/**
 * Which of a device's keys a packet opened under (m3-updates-design section 7): `next` only during
 * a key change after a restore, when `KeyStore` holds both and `open` tries `next` first.
 */
export type KeyUsed = "current" | "next";

/** An opened packet, with the key it opened under; absent is `current`. */
export type DeviceOpened = OpenedPacket & { readonly keyUsed?: KeyUsed };

/** Why a packet did not open, with its plaintext when it was authentic (section 8, §5, §11). */
export interface OpenFailure {
  readonly error: ProtocolError;
  /** The type byte and body, when the tag verified; never for a packet that failed its tag. */
  readonly plaintext: Uint8Array | undefined;
}

export interface OpenRequest {
  readonly binding: Uint8Array;
  readonly maxLength: MaxPacketLength;
}

/**
 * Pure: the same arguments always give the same bytes (AES-CCM is deterministic), so the core
 * stays a function of its inputs, and keys never enter the state, effects or records.
 */
export interface DeviceCipher {
  /**
   * Seals `message` under `device`'s key. An error is a programmer error in the core: no key for
   * the device, or a bad binding or direction (`sealPacket` throws `RangeError`; the shell wraps
   * it). SPEC-QUESTION: section 3 types the error as `CoreFault`, which carries the input's event
   * kind that the shell cannot know; it is a `HubError` of kind "crypto" here, and the core turns
   * it into a `CoreFault`.
   */
  seal(device: DeviceId, message: Message, request: SealRequest): Result<Uint8Array, HubError>;
  /**
   * Opens a packet to the hub under `device`'s key. Never fails except as the protocol says:
   * `badTag`, a bad header, a body that does not decode. A device with no key is `badTag`. When
   * the tag verified but the type or body does not decode, the failure carries the plaintext, so
   * the core can record the packet with its raw body (section 8, "Accepting a device packet").
   */
  open(
    device: DeviceId,
    packet: Uint8Array,
    request: OpenRequest,
  ): Result<DeviceOpened, OpenFailure>;
}
