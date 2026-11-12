/** The packet's clear header (section 3): readable before the key is known. */
import { ByteReader, MAX_U32 } from "../bytes.ts";
import { fail, ok, type Result } from "../result.ts";

export const PROTOCOL_VERSION = 1;

/** The direction bit: 0 to the hub, 1 from the hub. Also the nonce's direction byte. */
export const Direction = { ToHub: 0, FromHub: 1 } as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** Header byte, address and counter. */
export const CLEAR_HEADER_LENGTH = 9;
export const TAG_LENGTH = 8;
export const KEY_LENGTH = 16;
/** Clear header, type byte and tag, with an empty body. */
export const MIN_PACKET_LENGTH = CLEAR_HEADER_LENGTH + 1 + TAG_LENGTH;

/** Largest packet on each kind of path. Forwarded packets and log entries need the larger one. */
export const MaxPacketLength = { Radio: 255, Link: 1024 } as const;
export type MaxPacketLength = (typeof MaxPacketLength)[keyof typeof MaxPacketLength];

const VERSION_SHIFT = 4;
const DIRECTION_SHIFT = 3;

export interface PacketHeader {
  readonly direction: Direction;
  readonly address: number;
  readonly counter: number;
}

/** True for an address the hub can give out: never 0 or 0xFFFFFFFF. */
export function isValidAddress(address: number): boolean {
  return Number.isInteger(address) && address > 0 && address < MAX_U32;
}

/** True for a counter a sender may use: never 0. */
export function isValidCounter(counter: number): boolean {
  return Number.isInteger(counter) && counter > 0 && counter <= MAX_U32;
}

/** The header byte a sender writes: 0x10 to the hub, 0x18 from the hub. */
export function headerByte(direction: Direction): number {
  return (PROTOCOL_VERSION << VERSION_SHIFT) | (direction << DIRECTION_SHIFT);
}

/**
 * Reads the clear header so a receiver can find the key by address. Nothing here is
 * authenticated yet. Checks the packet's size, version, address and counter; the low three
 * header bits are ignored, as receivers must (they are still authenticated as sent). Address 0
 * or 0xFFFFFFFF and counter 0 are dropped here, before any key lookup (section 3).
 */
export function readPacketHeader(
  packet: Uint8Array,
  maxLength: MaxPacketLength,
): Result<PacketHeader> {
  if (packet.length < MIN_PACKET_LENGTH) return fail("truncated");
  if (packet.length > maxLength) return fail("tooLong");
  const reader = new ByteReader(packet);
  const header = reader.u8() ?? 0;
  const address = reader.u32() ?? 0;
  const counter = reader.u32() ?? 0;
  if (header >> VERSION_SHIFT !== PROTOCOL_VERSION) return fail("badVersion");
  if (!isValidAddress(address)) return fail("badAddress");
  if (!isValidCounter(counter)) return fail("badCounter");
  const direction = (header >> DIRECTION_SHIFT) & 1 ? Direction.FromHub : Direction.ToHub;
  return ok({ direction, address, counter });
}
