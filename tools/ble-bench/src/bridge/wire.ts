/**
 * The bridge's wire (m3-design.md section 5, "A bridge for the simulators"): how a development
 * build in the iOS simulator or the Android emulator reaches the scripted boards, one JSON text
 * message per WebSocket message, bytes as lowercase hex. It is `BleCentral`'s calls and events
 * written down, nothing more:
 *
 *   phone → bench   hello {v}                 the wire's version, first
 *                   state {id}                → reply: "on" | "off" | …
 *                   scan {scan, service}      → advert events, until stopScan {scan}
 *                   connect {id, device, mtu} → reply: {link, mtu}
 *                   write {id, link, char, data, response} → reply: null
 *                   read {id, link, char}     → reply: hex
 *                   watch {watch, link, char} → notify events, until unwatch {watch}
 *                   close {link}
 *   bench → phone   hello {v}, reply {id, ok, value | fault}, advert {scan, advert},
 *                   notify {watch, data}, closed {link, fault}
 *
 * This file is shared by the bench (Bun) and the development build (Metro, Hermes): it uses no
 * runtime API, and reading never throws: a message that is not one of these is `undefined`.
 */
import type { Advert, BleFault, BleState } from "../../../../app/src/platform/ble.ts";
import { parseJson } from "../safe/json.ts";

/** The wire's version, the first thing each end says. Also the marker the release check seeks. */
export const BRIDGE_WIRE = "hsn-ble-bench/1";

export type ToBench =
  | { readonly t: "hello"; readonly v: string }
  | { readonly t: "state"; readonly id: number }
  | { readonly t: "scan"; readonly scan: number; readonly service: string }
  | { readonly t: "stopScan"; readonly scan: number }
  | { readonly t: "connect"; readonly id: number; readonly device: string; readonly mtu: number }
  | {
      readonly t: "write";
      readonly id: number;
      readonly link: number;
      readonly char: string;
      readonly data: string;
      readonly response: boolean;
    }
  | { readonly t: "read"; readonly id: number; readonly link: number; readonly char: string }
  | { readonly t: "watch"; readonly watch: number; readonly link: number; readonly char: string }
  | { readonly t: "unwatch"; readonly watch: number }
  | { readonly t: "close"; readonly link: number };

export interface WireAdvert {
  readonly id: string;
  readonly name: string | null;
  readonly serviceData: string | null;
  readonly rssi: number;
}

export type ReplyValue = null | string | { readonly link: number; readonly mtu: number };

export type ToPhone =
  | { readonly t: "hello"; readonly v: string }
  | { readonly t: "reply"; readonly id: number; readonly ok: true; readonly value: ReplyValue }
  | { readonly t: "reply"; readonly id: number; readonly ok: false; readonly fault: BleFault }
  | { readonly t: "advert"; readonly scan: number; readonly advert: WireAdvert }
  | { readonly t: "notify"; readonly watch: number; readonly data: string }
  | { readonly t: "closed"; readonly link: number; readonly fault: BleFault | null };

const FAULTS: readonly BleFault[] = [
  "off",
  "unauthorized",
  "notFound",
  "lost",
  "timeout",
  "failed",
];
const STATES: readonly BleState[] = ["on", "off", "unauthorized", "unsupported"];

export function isBleFault(value: unknown): value is BleFault {
  return typeof value === "string" && (FAULTS as readonly string[]).includes(value);
}

export function isBleState(value: unknown): value is BleState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

// ----- Hex, without the runtime -----

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += (HEX[byte >> 4] ?? "") + (HEX[byte & 15] ?? "");
  return out;
}

/** Lowercase hex of whole bytes, or undefined. */
export function fromHex(text: string): Uint8Array | undefined {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(text)) return undefined;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function advertToWire(advert: Advert): WireAdvert {
  return {
    id: advert.id,
    name: advert.name,
    serviceData: advert.serviceData === null ? null : toHex(advert.serviceData),
    rssi: advert.rssi,
  };
}

export function advertFromWire(advert: WireAdvert): Advert | undefined {
  const serviceData = advert.serviceData === null ? null : fromHex(advert.serviceData);
  if (serviceData === undefined) return undefined;
  return { id: advert.id, name: advert.name, serviceData, rssi: advert.rssi };
}

// ----- Reading, field by field -----

type Fields = Readonly<Record<string, unknown>>;

function object(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const str = (value: unknown): value is string => typeof value === "string";
const hex = (value: unknown): value is string => str(value) && fromHex(value) !== undefined;

function parse(text: string): Fields | undefined {
  const json = parseJson(text);
  return json.ok ? object(json.value) : undefined;
}

/** A message to the bench, or undefined. */
export function readToBench(text: string): ToBench | undefined {
  const m = parse(text);
  if (m === undefined) return undefined;
  switch (m.t) {
    case "hello":
      return str(m.v) ? { t: "hello", v: m.v } : undefined;
    case "state":
      return int(m.id) ? { t: "state", id: m.id } : undefined;
    case "scan":
      return int(m.scan) && str(m.service)
        ? { t: "scan", scan: m.scan, service: m.service }
        : undefined;
    case "stopScan":
      return int(m.scan) ? { t: "stopScan", scan: m.scan } : undefined;
    case "connect":
      return int(m.id) && str(m.device) && int(m.mtu)
        ? { t: "connect", id: m.id, device: m.device, mtu: m.mtu }
        : undefined;
    case "write":
      return int(m.id) &&
        int(m.link) &&
        str(m.char) &&
        hex(m.data) &&
        typeof m.response === "boolean"
        ? { t: "write", id: m.id, link: m.link, char: m.char, data: m.data, response: m.response }
        : undefined;
    case "read":
      return int(m.id) && int(m.link) && str(m.char)
        ? { t: "read", id: m.id, link: m.link, char: m.char }
        : undefined;
    case "watch":
      return int(m.watch) && int(m.link) && str(m.char)
        ? { t: "watch", watch: m.watch, link: m.link, char: m.char }
        : undefined;
    case "unwatch":
      return int(m.watch) ? { t: "unwatch", watch: m.watch } : undefined;
    case "close":
      return int(m.link) ? { t: "close", link: m.link } : undefined;
    default:
      return undefined;
  }
}

function readReplyValue(value: unknown): ReplyValue | undefined {
  if (value === null || str(value)) return value;
  const o = object(value);
  return o !== undefined && int(o.link) && int(o.mtu) ? { link: o.link, mtu: o.mtu } : undefined;
}

function readAdvert(value: unknown): WireAdvert | undefined {
  const a = object(value);
  if (a === undefined || !str(a.id) || !(a.name === null || str(a.name))) return undefined;
  if (!(a.serviceData === null || hex(a.serviceData)) || typeof a.rssi !== "number")
    return undefined;
  return { id: a.id, name: a.name, serviceData: a.serviceData, rssi: a.rssi };
}

/** A message to the phone, or undefined. */
export function readToPhone(text: string): ToPhone | undefined {
  const m = parse(text);
  if (m === undefined) return undefined;
  switch (m.t) {
    case "hello":
      return str(m.v) ? { t: "hello", v: m.v } : undefined;
    case "reply": {
      if (!int(m.id)) return undefined;
      if (m.ok === true) {
        const value = readReplyValue(m.value);
        return value === undefined ? undefined : { t: "reply", id: m.id, ok: true, value };
      }
      return m.ok === false && isBleFault(m.fault)
        ? { t: "reply", id: m.id, ok: false, fault: m.fault }
        : undefined;
    }
    case "advert": {
      const advert = readAdvert(m.advert);
      return int(m.scan) && advert !== undefined
        ? { t: "advert", scan: m.scan, advert }
        : undefined;
    }
    case "notify":
      return int(m.watch) && hex(m.data)
        ? { t: "notify", watch: m.watch, data: m.data }
        : undefined;
    case "closed":
      return int(m.link) && (m.fault === null || isBleFault(m.fault))
        ? { t: "closed", link: m.link, fault: m.fault }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The bridge's address must be this Mac: loopback, or the Android emulator's name for the
 * Mac's loopback (10.0.2.2). Nothing goes anywhere else.
 */
export function isLocalBridge(url: string): boolean {
  return /^ws:\/\/(?:127\.0\.0\.1|localhost|10\.0\.2\.2|\[::1\]):\d{1,5}(?:\/[^\s]*)?$/u.test(url);
}
