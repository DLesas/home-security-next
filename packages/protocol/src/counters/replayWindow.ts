/**
 * The hub's receive window for sensors and sirens (section 4): accept a counter higher than
 * any accepted, or one of the 64 below the highest not seen yet. Pure logic; the caller keeps
 * the state, saved with every packet, and applies this only after the tag has verified.
 */
import { ByteReader, ByteWriter, MAX_U32 } from "../bytes.ts";
import { fail, ok, type Result } from "../result.ts";
import { accept, assertReceivedCounter, type CounterCheck, reject } from "./check.ts";

export const REPLAY_WINDOW_SIZE = 64;
const WINDOW_MASK = (1n << BigInt(REPLAY_WINDOW_SIZE)) - 1n;

export interface ReplayWindow {
  /** The highest counter accepted; 0 before the first. */
  readonly highest: number;
  /** Bit i set: counter `highest − 1 − i` was accepted. */
  readonly seenBelow: bigint;
}

export const EMPTY_REPLAY_WINDOW: ReplayWindow = { highest: 0, seenBelow: 0n };

export function checkReplayWindow(
  window: ReplayWindow,
  counter: number,
): CounterCheck<ReplayWindow> {
  assertReceivedCounter(counter);
  const { highest, seenBelow } = window;

  if (counter > highest) {
    const shift = counter - highest;
    let seen = shift < REPLAY_WINDOW_SIZE ? (seenBelow << BigInt(shift)) & WINDOW_MASK : 0n;
    // The old highest now sits shift − 1 below the new one, if it is still inside the window.
    if (highest > 0 && shift <= REPLAY_WINDOW_SIZE) seen |= 1n << BigInt(shift - 1);
    return accept({ highest: counter, seenBelow: seen });
  }

  const distance = highest - counter;
  if (distance === 0) return reject("duplicate");
  if (distance > REPLAY_WINDOW_SIZE) return reject("tooOld");
  const bit = 1n << BigInt(distance - 1);
  if ((seenBelow & bit) !== 0n) return reject("duplicate");
  return accept({ highest, seenBelow: seenBelow | bit });
}

/** Length of a stored window: the highest counter (4) then the seen bits (8), little-endian. */
export const REPLAY_WINDOW_BYTES = 12;

export function encodeReplayWindow(window: ReplayWindow): Uint8Array {
  return new ByteWriter()
    .u32(window.highest)
    .u32(Number(window.seenBelow & BigInt(MAX_U32)))
    .u32(Number((window.seenBelow >> 32n) & BigInt(MAX_U32)))
    .finish();
}

export function decodeReplayWindow(bytes: Uint8Array): Result<ReplayWindow> {
  if (bytes.length < REPLAY_WINDOW_BYTES) return fail("truncated");
  if (bytes.length > REPLAY_WINDOW_BYTES) return fail("tooLong");
  const reader = new ByteReader(bytes);
  const highest = reader.u32() ?? 0;
  const low = BigInt(reader.u32() ?? 0);
  const high = BigInt(reader.u32() ?? 0);
  return ok({ highest, seenBelow: (high << 32n) | low });
}
