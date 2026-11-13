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
 */
import { ok, type Result } from "neverthrow";
import {
  Direction,
  MaxPacketLength,
  type Message,
  NO_BINDING,
  type ProtocolError,
  readPacketHeader,
  type ReplayWindow,
} from "@hsn/protocol";
import type { DeviceCipher } from "../model/cipher.ts";
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
    };

/** What the checks read of the intake's state. */
export interface KnownWindows {
  readonly deviceAt: (address: number) => DeviceId | undefined;
  readonly windowOf: (device: DeviceId) => ReplayWindow;
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
  if (opened.isErr()) {
    const { error, plaintext } = opened.error;
    // The header passed above, so any error but the tag's comes after the tag verified.
    if (error.code === "badTag") return ok(rejected("badTag", address));
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
  const message = opened.value.message;
  if (!onItsPath(message.type, arrival.path)) return ok(rejected("wrongPath", address));
  return windowCheck(window, counter).map((check): Verdict =>
    check.accepted
      ? {
          kind: "accepted",
          device,
          address,
          counter,
          message,
          window: check.window,
          newest: counter > window.highest,
        }
      : rejected(check.reason, address),
  );
}

/** The `unknownType` error's type byte, for the record of an authentic packet of that type. */
export function unknownTypeOf(error: ProtocolError): number | undefined {
  return error.code === "unknownType" ? error.messageType : undefined;
}
