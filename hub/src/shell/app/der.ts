/**
 * The few DER encodings (ITU-T X.690) a self-signed X.509 certificate needs (m2-design.md
 * section 5, "The certificate"): lengths, sequences, sets, integers, object identifiers, strings,
 * times, bit and octet strings, and context-specific tags. Encoding only: the hub reads its own
 * certificate back through `node:crypto`'s parser (`certificate.ts`), never through code of ours.
 * Pure, and never throws.
 */

/** The universal tags used here. */
const TAG = {
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  oid: 0x06,
  utf8String: 0x0c,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  boolean: 0x01,
  sequence: 0x30,
  set: 0x31,
} as const;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A length in DER's definite form: short below 128, else 0x80 + its byte count, big-endian. */
function lengthBytes(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** One element: its tag, its length and its contents. */
export function element(tag: number, contents: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), lengthBytes(contents.length), contents]);
}

export function sequence(...items: readonly Uint8Array[]): Uint8Array {
  return element(TAG.sequence, concat(items));
}

export function set(...items: readonly Uint8Array[]): Uint8Array {
  return element(TAG.set, concat(items));
}

/** A non-negative integer from its big-endian bytes, with a leading zero when the top bit is set. */
export function unsignedInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  const first = trimmed[0] ?? 0;
  return element(
    TAG.integer,
    first >= 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed.slice(),
  );
}

export function smallInteger(value: number): Uint8Array {
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return unsignedInteger(Uint8Array.from(bytes.length === 0 ? [0] : bytes));
}

export function boolean(value: boolean): Uint8Array {
  return element(TAG.boolean, Uint8Array.of(value ? 0xff : 0x00));
}

/** An object identifier from its dotted text (`1.2.840.10045.4.3.2`). */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const [a = 0, b = 0, ...rest] = arcs;
  const bytes: number[] = [a * 40 + b];
  for (const arc of rest) {
    const chunk: number[] = [arc % 128];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128))
      chunk.unshift(0x80 | (n % 128));
    bytes.push(...chunk);
  }
  return element(TAG.oid, Uint8Array.from(bytes));
}

export function utf8String(text: string): Uint8Array {
  return element(TAG.utf8String, new TextEncoder().encode(text));
}

export function octetString(bytes: Uint8Array): Uint8Array {
  return element(TAG.octetString, bytes);
}

/** A bit string of whole bytes: no unused bits. */
export function bitString(bytes: Uint8Array): Uint8Array {
  return element(TAG.bitString, concat([Uint8Array.of(0), bytes]));
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** A time as X.509 wants it (RFC 5280, 4.1.2.5): UTCTime before 2050, GeneralizedTime from it. */
export function time(ms: number): Uint8Array {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const rest = `${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  return year < 2050
    ? element(TAG.utcTime, new TextEncoder().encode(`${two(year % 100)}${rest}`))
    : element(TAG.generalizedTime, new TextEncoder().encode(`${String(year)}${rest}`));
}

/** A context-specific element: `[n]`, constructed (EXPLICIT) or primitive (IMPLICIT). */
export function tagged(n: number, contents: Uint8Array, constructed: boolean): Uint8Array {
  return element((constructed ? 0xa0 : 0x80) | n, contents);
}
