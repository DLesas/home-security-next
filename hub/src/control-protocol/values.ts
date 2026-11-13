/**
 * Values shared by the control socket's messages (hub-design.md section 9). Everything here
 * is JSON: bytes travel as lowercase hex, times as integers.
 */
import { z } from "zod";

/** Bytes as lowercase hex with no separators, as the protocol's vector files write them. */
export const hexBytes = z.string().regex(/^(?:[0-9a-f]{2})*$/, "lowercase hex, two digits a byte");

/**
 * A device's name, as `hsn` commands take it. SPEC-QUESTION: section 9 sets no rule for names;
 * this allows 1 to 64 characters with no white space, which covers `gateway-<chip>` (D100).
 */
export const deviceName = z.string().regex(/^\S{1,64}$/, "1 to 64 characters, no spaces");

/** Data rate index, DR0 to DR5 (§2). */
export const dataRate = z.int().min(0).max(5);

/** Site channel as the protocol numbers it: 0 = 868.1, 1 = 868.3, 2 = 868.5 MHz (§6). */
export const siteChannel = z.int().min(0).max(2);

/** Device roles, as `usb add --role` takes them (§10, Set role). */
export const roleName = z.enum(["sensor", "siren", "gateway"]);

/** An unsigned integer of `bits` bits. */
export function unsigned(bits: 8 | 16 | 32): z.ZodInt {
  return z
    .int()
    .min(0)
    .max(2 ** bits - 1);
}

/** A whole number of milliseconds or microseconds; never negative. */
export const time = z.int().min(0);
