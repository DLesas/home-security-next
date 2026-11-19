/**
 * Accepting a device packet (hub-design.md section 8, "Accepting a device packet"; protocol.md
 * §3, §4, §5). The checks run in the order the protocol fixes: the clear header (version, length,
 * address, counter) and its direction bit; a known address, else `unknownAddress` with no AES
 * spent; the tag; then the counter against the 64-packet replay window. Pure: the cipher is the
 * deterministic one the core is handed.
 *
 * Two readings of the order, each for a reason:
 * - The path check (§5, "Paths") needs the type, which is encrypted, so it follows the tag; it
 *   comes before the window, so a wrong-path copy, such as a recorded LoRa packet relayed over
 *   the network, cannot use up the counter of the real one.
 * - An authentic packet that does not decode (an unknown type, a short body, a type that does
 *   not travel to the hub) is still entered in the window, so each replay of it is refused
 *   without being opened and logged again (section 13's last flaw of the test hub; section 8 for
 *   unknown types).
 *
 * During a key change after a restore (D141, m3-updates-design section 7) the key a packet opened
 * under decides, after the path check and before the window:
 * - a device marked `Required`: under its next key, the switch: the window starts again, empty,
 *   and the packet is checked against it as any other; under its current key, a key held at the
 *   backup: `oldKey`, never entered in the window and never acted on;
 * - a device marked `BothHeld`: under either key, `oldKey`;
 * - a device switched in this run: under its new key (which the cipher names `next` for the rest of
 *   the run), as usual; under the current key, which is then the old one, `badTag`, as from a
 *   stranger;
 * - during a change, an authentic packet that does not decode is counted and nothing more: which
 *   key opened it is not known, so it is not entered in a window.
 */
import { ok, type Result } from "neverthrow";
import {
  Direction,
  EMPTY_REPLAY_WINDOW,
  MaxPacketLength,
  type Message,
  NO_BINDING,
  type ProtocolError,
  readPacketHeader,
  type ReplayWindow,
  type StartedImage,
} from "@hsn/protocol";
import type { DeviceCipher, KeyUsed } from "../model/cipher.ts";
import type { HubError, RejectReason } from "../model/errors.ts";
import type { DeviceId } from "../model/ids.ts";
import type { Arrival } from "../model/messages.ts";
import { safeCheckReplayWindow } from "../util/protocol-safe.ts";
import { onItsPath } from "./classes.ts";

/** What the checks found. */
export type Verdict =
  /** Dropped and counted, nothing else: `address` when the header gave one. */
  | {
      readonly kind: "rejected";
      readonly reason: RejectReason;
      readonly address: number | undefined;
    }
  /** Authentic, entered in the window, and not acted on: counted with `reason`. */
  | {
      readonly kind: "authenticInvalid";
      readonly device: DeviceId;
      readonly address: number;
      readonly counter: number;
      readonly window: ReplayWindow;
      readonly error: ProtocolError;
      /** The type byte and body, as decrypted (section 8: recorded with its raw body). */
      readonly plaintext: Uint8Array;
    }
  /** Authentic and accepted by the window. */
  | {
      readonly kind: "accepted";
      readonly device: DeviceId;
      readonly address: number;
      readonly counter: number;
      readonly message: Message;
      readonly window: ReplayWindow;
      /** Its counter is above every one accepted before: readings follow it (section 8). */
      readonly newest: boolean;
      /** The first packet under the device's new key after a restore: it switches the device. */
      readonly switched: boolean;
      /** A Started's M3 fields, as the cipher read them (`OpenedPacket.startedImage`). */
      readonly startedImage: StartedImage | undefined;
    }
  /** Authentic under a key held at the backup (D141): never entered in the window, never acted on. */
  | {
      readonly kind: "oldKey";
      readonly device: DeviceId;
      readonly address: number;
      readonly counter: number;
      readonly message: Message;
      readonly keyUsed: KeyUsed;
    };

/** Where a device is in a key change after a restore (`device_keys.rekey`, D141). */
export type KeyState =
  /** No change: its packets open under its key, as before M3. */
  | "none"
  /** `Rekey.Required`: its key was held at the backup; its next key, made since, switches it. */
  | "required"
  /** `Rekey.BothHeld`: both its keys were held at the backup. */
  | "bothHeld"
  /** Switched in this run: its new key opens as `next` until the hub restarts. */
  | "switched";

/** What the checks read of the intake's state. */
export interface KnownWindows {
  readonly deviceAt: (address: number) => DeviceId | undefined;
  readonly windowOf: (device: DeviceId) => ReplayWindow;
  readonly keyStateOf: (device: DeviceId) => KeyState;
}

/** The size limit a path allows (§3): a radio packet through a gateway, 1,024 bytes on a link. */
export function maxLengthOf(arrival: Arrival): MaxPacketLength {
  return arrival.path === "lora" ? MaxPacketLength.Radio : MaxPacketLength.Link;
}

function rejected(reason: RejectReason, address?: number): Verdict {
  return { kind: "rejected", reason, address };
}

/** The counter against the window: accepted, or `duplicate` or `tooOld` (§4). */
function windowCheck(
  window: ReplayWindow,
  counter: number,
): Result<
  | { readonly accepted: true; readonly window: ReplayWindow }
  | { readonly accepted: false; readonly reason: RejectReason },
  HubError
> {
  return safeCheckReplayWindow(window, counter).map((check) =>
    check.accepted
      ? { accepted: true as const, window: check.state }
      : { accepted: false as const, reason: check.reason },
  );
}

/** Runs every check on one device packet, in order. */
export function checkPacket(
  known: KnownWindows,
  cipher: DeviceCipher,
  bytes: Uint8Array,
  arrival: Arrival,
): Result<Verdict, HubError> {
  const maxLength = maxLengthOf(arrival);
  const header = readPacketHeader(bytes, maxLength);
  if (!header.ok) return ok(rejected(header.error.code));
  const { address, counter, direction } = header.value;
  if (direction !== Direction.ToHub) return ok(rejected("wrongDirection", address));
  const device = known.deviceAt(address);
  if (device === undefined) return ok(rejected("unknownAddress", address));

  const opened = cipher.open(device, bytes, { binding: NO_BINDING, maxLength });
  const window = known.windowOf(device);
  const state = known.keyStateOf(device);
  if (opened.isErr()) {
    const { error, plaintext } = opened.error;
    // The header passed above, so any error but the tag's comes after the tag verified.
    if (error.code === "badTag") return ok(rejected("badTag", address));
    if (state !== "none") return ok(rejected(error.code, address));
    return windowCheck(window, counter).map((check): Verdict =>
      check.accepted
        ? {
            kind: "authenticInvalid",
            device,
            address,
            counter,
            window: check.window,
            error,
            plaintext: plaintext ?? new Uint8Array(),
          }
        : rejected(check.reason, address),
    );
  }
  const { message, startedImage } = opened.value;
  const keyUsed: KeyUsed = opened.value.keyUsed ?? "current";
  if (!onItsPath(message.type, arrival.path)) return ok(rejected("wrongPath", address));
  const oldKey: Verdict = { kind: "oldKey", device, address, counter, message, keyUsed };
  switch (state) {
    case "bothHeld":
      return ok(oldKey);
    case "required":
      if (keyUsed === "current") return ok(oldKey);
      break;
    case "switched":
      // The key that was current is the old one now: its packets fail, as a stranger's (D141).
      if (keyUsed === "current") return ok(rejected("badTag", address));
      break;
    case "none":
      break;
  }
  const switched = state === "required";
  // Counters start again under a new key (§4): the window starts again with it.
  const from = switched ? EMPTY_REPLAY_WINDOW : window;
  return windowCheck(from, counter).map((check): Verdict =>
    check.accepted
      ? {
          kind: "accepted",
          device,
          address,
          counter,
          message,
          window: check.window,
          newest: counter > from.highest,
          switched,
          startedImage,
        }
      : rejected(check.reason, address),
  );
}

/** The `unknownType` error's type byte, for the record of an authentic packet of that type. */
export function unknownTypeOf(error: ProtocolError): number | undefined {
  return error.code === "unknownType" ? error.messageType : undefined;
}
