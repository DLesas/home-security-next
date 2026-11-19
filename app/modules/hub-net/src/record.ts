/**
 * Reading what a browse found (protocol.md section 10, "Finding the hub"; m3-design.md section 2):
 * the TXT record, as bytes (RFC 6763 section 6) or as the platform's map; the three keys the hub
 * gives; and the addresses a service resolved to.
 *
 * Nothing here is trusted for identity. The record only chooses where to try: the phone proves
 * the hub by its Noise key, which it pinned at linking. So a record is read strictly, and one with
 * a key missing or malformed is not used at all, rather than guessed at.
 */
import { parseIdentity } from "@hsn/protocol/app";
import type { NativeTxt } from "./contract";

/** A TXT record's keys, lower-cased, each with its value's bytes, or null for a key without `=`. */
export type TxtEntries = ReadonlyMap<string, Uint8Array | null>;

const EQUALS = 0x3d;

const lower = (key: string) => key.replace(/[A-Z]/gu, (c) => c.toLowerCase());

/**
 * A key as RFC 6763 section 6.4 allows it, lower-cased: at least one character, each printable
 * US-ASCII but `=`. Given as text whose characters are the key's bytes.
 */
function keyText(text: string): string | undefined {
  if (text.length === 0) return undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || c === EQUALS) return undefined;
  }
  return lower(text);
}

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/**
 * A TXT record's bytes as its entries: each string a length byte and that many bytes. A string
 * that overruns the record makes the whole record unreadable (undefined). As RFC 6763 section 6
 * says: an empty string, a string with no key ("=value") or a key that is not printable ASCII is
 * skipped; a key is matched without regard to case; a key given twice keeps its first value.
 */
export function txtFromWire(bytes: Uint8Array): TxtEntries | undefined {
  const out = new Map<string, Uint8Array | null>();
  let at = 0;
  while (at < bytes.length) {
    const length = bytes[at] ?? 0;
    const start = at + 1;
    const end = start + length;
    if (end > bytes.length) return undefined;
    at = end;
    const text = bytes.subarray(start, end);
    const equals = text.indexOf(EQUALS);
    const key = keyText(latin1(equals === -1 ? text : text.subarray(0, equals)));
    if (key === undefined || out.has(key)) continue;
    out.set(key, equals === -1 ? null : text.slice(equals + 1));
  }
  return out;
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A TXT record as Android's map gives it. Its order is not the record's, so a key given twice in
 * different cases cannot be told first: with the same value it is kept, with different values the
 * record is unreadable (undefined). A key that is not printable ASCII is skipped, as on the wire.
 */
export function txtFromEntries(
  entries: readonly (readonly [string, Uint8Array | null])[],
): TxtEntries | undefined {
  const out = new Map<string, Uint8Array | null>();
  for (const [name, value] of entries) {
    const key = keyText(name);
    if (key === undefined) continue;
    const before = out.get(key);
    if (before !== undefined && !sameBytes(before, value)) return undefined;
    out.set(key, value);
  }
  return out;
}

/** The record as the platform gave it, read. */
export function txtOf(txt: NativeTxt): TxtEntries | undefined {
  return txt.kind === "raw" ? txtFromWire(txt.bytes) : txtFromEntries(txt.entries);
}

// ----- The hub's keys -----

/** The TXT keys the hub gives (`hub/src/shell/advertise/mdns.ts`). */
export const TXT_KEYS = { id: "id", appsPort: "app", identity: "aid" } as const;

/** What a hub's record says, read. */
export interface HubRecord {
  /** `id`: the hub identity of protocol.md section 9, 16 lower-case hex digits; devices use it. */
  readonly id: string;
  /** `aid`: the app identity, 26 characters of base32. */
  readonly identity: string;
  /** `app`: the apps' port. */
  readonly appsPort: number;
}

/**
 * Why a record is not used: a key the hub gives is missing (a hub whose apps' listener is not open
 * yet gives `id` alone); one is there but malformed; or the TXT record cannot be read at all.
 */
export type RecordFault = "missingKey" | "malformedKey" | "malformedTxt";

export type RecordRead =
  | { readonly ok: true; readonly record: HubRecord }
  | { readonly ok: false; readonly fault: RecordFault };

/** A value as text: printable ASCII with no space, which every key the hub gives is. */
function valueText(bytes: Uint8Array): string | undefined {
  let text = "";
  for (const b of bytes) {
    if (b < 0x21 || b > 0x7e) return undefined;
    text += String.fromCharCode(b);
  }
  return text;
}

/** The apps' port: decimal, no sign and no leading zero, 1 to 65535. */
function readPort(text: string): number | undefined {
  if (!/^[1-9]\d{0,4}$/u.test(text)) return undefined;
  const port = Number(text);
  return port <= 65_535 ? port : undefined;
}

/** A hub's record from its TXT entries: all three keys, each well formed, or why not. */
export function readHubRecord(txt: TxtEntries | undefined): RecordRead {
  if (txt === undefined) return { ok: false, fault: "malformedTxt" };
  const values = [TXT_KEYS.id, TXT_KEYS.appsPort, TXT_KEYS.identity].map((key) => txt.get(key));
  if (values.some((v) => v === undefined)) return { ok: false, fault: "missingKey" };
  const [id, appsPort, identity] = values.map((v) =>
    v === undefined || v === null ? undefined : valueText(v),
  );
  const port = appsPort === undefined ? undefined : readPort(appsPort);
  if (
    id === undefined ||
    !/^[0-9a-f]{16}$/iu.test(id) ||
    port === undefined ||
    identity === undefined ||
    parseIdentity(identity) === undefined
  )
    return { ok: false, fault: "malformedKey" };
  return { ok: true, record: { id: id.toLowerCase(), identity, appsPort: port } };
}

// ----- Addresses -----

function ipv4(text: string): readonly number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/u.test(p))) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : undefined;
}

function ipv6(text: string): readonly number[] | undefined {
  if (!/^[0-9a-f:.]+$/u.test(text) || text.split("::").length > 2) return undefined;
  /** A run of groups; only the address's last may be an IPv4 address. */
  const groups = (part: string, last: boolean): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const list = part.split(":");
    for (const [i, group] of list.entries()) {
      if (last && i === list.length - 1 && group.includes(".")) {
        const v4 = ipv4(group);
        if (v4 === undefined) return undefined;
        out.push(...v4);
      } else if (/^[0-9a-f]{1,4}$/u.test(group)) {
        const value = Number.parseInt(group, 16);
        out.push(value >> 8, value & 0xff);
      } else return undefined;
    }
    return out;
  };
  const [head = "", tail] = text.split("::");
  const front = groups(head, tail === undefined);
  const back = tail === undefined ? [] : groups(tail, true);
  if (front === undefined || back === undefined) return undefined;
  if (tail === undefined) return front.length === 16 ? front : undefined;
  const fill = 16 - front.length - back.length;
  return fill >= 2 ? [...front, ...new Array<number>(fill).fill(0), ...back] : undefined;
}

/**
 * An IPv6 address's 16 bytes in RFC 5952's text: lower case, no leading zeros, the longest run of
 * two or more zero groups (the first, if two are as long) written `::`. Each platform has its own
 * text (Java writes every group), so the app sees one form whichever phone found the hub.
 */
export function ipv6Text(bytes: readonly number[]): string {
  const words = Array.from(
    { length: 8 },
    (_, i) => ((bytes[2 * i] ?? 0) << 8) | (bytes[2 * i + 1] ?? 0),
  );
  let best = { at: -1, length: 0 };
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let end = i;
    while (end < 8 && words[end] === 0) end++;
    if (end - i > best.length) best = { at: i, length: end - i };
    i = end;
  }
  const hex = (list: readonly number[]) => list.map((w) => w.toString(16)).join(":");
  if (best.length < 2) return hex(words);
  return `${hex(words.slice(0, best.at))}::${hex(words.slice(best.at + best.length))}`;
}

/** An address's rank in the order tried: IPv4, then IPv6, then IPv6 link-local. */
type Rank = 0 | 1 | 2;

/**
 * One address as the platform wrote it, in the form the app's finder takes: an IPv4 address in
 * dotted decimal (an IPv4-mapped IPv6 address too); an IPv6 address in RFC 5952's text, without
 * brackets, keeping its zone (`fe80::1%en0`, which the finder leaves out: a code never carries
 * one).
 * Undefined for anything else.
 */
export function readAddress(
  text: string,
): { readonly address: string; readonly rank: Rank } | undefined {
  const bare = text.trim().replace(/^\[(.*)\]$/u, "$1");
  if (ipv4(bare) !== undefined) return { address: bare, rank: 0 };
  const percent = bare.indexOf("%");
  const body = lower(percent === -1 ? bare : bare.slice(0, percent));
  const zone = percent === -1 ? "" : bare.slice(percent + 1);
  if (percent !== -1 && !/^[0-9A-Za-z_.-]{1,32}$/u.test(zone)) return undefined;
  const bytes = ipv6(body);
  if (bytes === undefined) return undefined;
  const mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped && percent === -1) return { address: bytes.slice(12).join("."), rank: 0 };
  const linkLocal = bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80;
  const canonical = ipv6Text(bytes);
  return { address: percent === -1 ? canonical : `${canonical}%${zone}`, rank: linkLocal ? 2 : 1 };
}

/** A service's addresses, read, each once, IPv4 first; those that are not addresses are left out. */
export function readAddresses(list: readonly string[]): readonly string[] {
  const ranked: [string[], string[], string[]] = [[], [], []];
  const seen = new Set<string>();
  for (const text of list) {
    const one = readAddress(text);
    if (one === undefined || seen.has(one.address)) continue;
    seen.add(one.address);
    ranked[one.rank].push(one.address);
  }
  return ranked.flat();
}
