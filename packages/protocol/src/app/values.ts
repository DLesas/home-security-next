/**
 * The small values the app channel's messages are made of (docs/m2-design.md sections 5 and 6):
 * ids, revisions, times, names, bytes on the wire. Every schema is strict: a field the version
 * does not name is refused (section 5, "Versions").
 */
import { z } from "zod";
import { REQUEST_LIMITS } from "./constants.ts";

/** A row id of the hub's tables (`devices`, `people`, `clients`, `groups`, `modes`, …): 1 or more. */
export const objectId = z
  .int()
  .min(1)
  .max(2 ** 32 - 1);

/** A device's number (`devices.id`). */
export const deviceRef = objectId;
export const personRef = objectId;
export const clientRef = objectId;
export const groupRef = objectId;
export const modeRef = objectId;
export const scheduleRef = objectId;
export const tokenRef = objectId;
export const jobRef = objectId;

/** An editable object's revision, raised by one at each change (section 4). */
export const revision = z.int().min(0);

/** A request's `id`, the client's own (section 5). */
export const requestIdValue = z.int().min(1).max(REQUEST_LIMITS.maxId);

/** A change's `seq` (section 5). */
export const seqValue = z.int().min(1).max(REQUEST_LIMITS.maxSeq);

/** A record's sequence number (`seq`, HD 6): boot × 2³² + n. */
export const recordSeqValue = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Wall milliseconds since 1970 (HD 6). */
export const wallMs = z.int().min(0);

/** A duration in milliseconds. */
export const durationMs = z.int().min(0);

/** The live revision of events (section 5): rises by one at every step that changes what an app shows. */
export const liveRevision = z.int().min(0);

/** A run of the hub (`boots.id`). */
export const bootValue = z.int().min(1);

/**
 * A name a person gives a person, a client, a group, a mode or a schedule (section 7, "Names"):
 * 1 to 64 characters; no control characters (Unicode category Cc); none of the bidirectional
 * controls U+202A to U+202E and U+2066 to U+2069 ‡, which could make one name display as another;
 * no white space at either end (so not only white space); in Unicode NFC. The app trims and
 * normalises before sending; the hub refuses, never alters. Devices keep HD 9's names.
 */
export const displayName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}‪-‮⁦-⁩]+$/u, "no control or bidirectional characters")
  .regex(/^\S(?:[\s\S]*\S)?$/u, "no white space at either end")
  .refine((name) => name.normalize("NFC") === name, "in Unicode NFC");

/** A device's name, as HD 9 has it (1 to 64 characters, no spaces). */
export const deviceNameValue = z.string().regex(/^\S{1,64}$/u, "1 to 64 characters, no spaces");

/** Bytes inside JSON: base64url without padding (RFC 4648 section 5). */
export const base64urlBytes = z.string().regex(/^[A-Za-z0-9_-]*$/u, "base64url without padding");

/** A SHA-256 as 64 lowercase hex digits. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u, "64 lowercase hex digits");

/** A local time of day, "HH:MM" (section 6). */
export const localTimeText = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "HH:MM, 00:00 to 23:59");

/** A local date, "YYYY-MM-DD" (section 6). */
export const localDateText = z.iso.date();

/**
 * A weekday (section 7, "Schedules"), in the order of `schedules.days`'s bits: Monday bit 0.
 */
export const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/** A weekday's bit in `schedules.days`. */
export function weekdayBit(day: z.infer<typeof weekday>): number {
  return 1 << weekday.options.indexOf(day);
}

/**
 * A list of weekdays: 1 to 7 days without repeats, in any order. The hub answers in Monday-first
 * order, and all seven as `"everyDay"` (section 7).
 */
export const weekdayList = z
  .array(weekday)
  .min(1)
  .max(7)
  .refine((days) => new Set(days).size === days.length, "no day twice")
  .readonly();

/** A protocol data rate DR0 to DR5. */
export const dataRateValue = z.int().min(0).max(5);

/** A site channel number, 0 = 868.1, 1 = 868.3, 2 = 868.5 MHz. */
export const siteChannelValue = z.int().min(0).max(2);

/** A device's role. */
export const roleValue = z.enum(["sensor", "siren", "gateway"]);

/** A client's kind (`clients.kind`, section 4). */
export const clientKind = z.enum(["console", "web", "phone"]);

/** Which listener a session came in on (section 5). */
export const listenerName = z.enum(["lan", "console"]);
