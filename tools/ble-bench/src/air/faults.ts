/**
 * Faults on demand (the brief's list): what the scripted air does to a connection, because the
 * app's Bluetooth code is judged by how it handles them. Each is a predicate over a **crossing**,
 * one write, notification or read on its way across the air, so a test can name exactly where it
 * happens ("drop after the 30th Data", "lose the 2nd Get", "corrupt the 5th piece"). The helpers
 * at the end build the common ones from the transfer frames' kinds.
 *
 * A board's own faults (it vanishes, it is slow, it stores nothing, a second phone) are the
 * board's and the central's options; these are the air's.
 */
import {
  TRANSFER_PREFIX,
  TransferKind,
} from "../../../../packages/protocol/src/update/transfer.ts";

export interface Crossing {
  readonly direction: "toBoard" | "toPhone";
  readonly kind: "write" | "notify" | "read";
  readonly characteristic: string;
  readonly data: Uint8Array;
  /** Its number among the crossings of the same direction and kind on this connection, from 1. */
  readonly index: number;
  /** The connection to this board it crosses, from 1. */
  readonly connection: number;
}

export interface Faults {
  /** One-way time across the air, in milliseconds (default 0: the next turn of the clock). */
  readonly latencyMs?: number;
  /** How long the board takes before it acts on anything that reaches it: a slow board. */
  readonly boardDelayMs?: number;
  /** The connection drops just after this crossing is delivered (both ends see it go). */
  readonly dropAfter?: (crossing: Crossing) => boolean;
  /**
   * This crossing never arrives. Only a notification or a write without response can be lost:
   * a write with response or a read is acknowledged at the link layer, so its loss is a drop.
   */
  readonly lose?: (crossing: Crossing) => boolean;
  /** This crossing arrives twice. */
  readonly repeat?: (crossing: Crossing) => boolean;
  /** This crossing arrives with these bytes instead (a corrupted piece). */
  readonly corrupt?: (crossing: Crossing) => Uint8Array | undefined;
  /** The `attempt`th connection to this board (from 1) fails. */
  readonly refuseConnect?: (attempt: number) => boolean;
}

/** True for a transfer frame of `kind`. */
export function isFrame(data: Uint8Array, kind: TransferKind): boolean {
  return data[0] === TRANSFER_PREFIX && data[1] === kind;
}

/**
 * A predicate true at the `n`th frame of `kind` crossing in `direction` over every connection
 * to the board (counted across reconnections), and only that once.
 */
export function nthFrame(
  kind: TransferKind,
  n: number,
  direction: Crossing["direction"] = kind === TransferKind.Data || kind === TransferKind.Open
    ? "toBoard"
    : "toPhone",
): (crossing: Crossing) => boolean {
  let seen = 0;
  return (crossing) => {
    if (crossing.direction !== direction || !isFrame(crossing.data, kind)) return false;
    seen += 1;
    return seen === n;
  };
}

/** The bytes of a frame with one bit of its last byte flipped: a Data whose CRC no longer holds. */
export function flipLastBit(data: Uint8Array): Uint8Array {
  const out = data.slice();
  const last = out.length - 1;
  if (last >= 0) out[last] = (out[last] ?? 0) ^ 0x01;
  return out;
}

/** `corrupt` for the `n`th Data a phone writes: its last data byte flipped. */
export function corruptNthData(n: number): (crossing: Crossing) => Uint8Array | undefined {
  const nth = nthFrame(TransferKind.Data, n, "toBoard");
  return (crossing) => (nth(crossing) ? flipLastBit(crossing.data) : undefined);
}

export { TransferKind };
