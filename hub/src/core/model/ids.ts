/**
 * Ids (hub-design.md sections 2 and 6). Each is a number branded with its kind, so a device id
 * cannot be passed where a link id is expected. The functions below are the one place a plain
 * number becomes an id.
 */

import { MODULE_ORDER, type ModuleName } from "./modules.ts";

/** A row id of `devices` (section 6). Device 0 is the hub itself. */
export type DeviceId = number & { readonly __brand: "DeviceId" };

/** A row id of `boots`: one per run of the hub (sections 5 and 6). */
export type BootId = number & { readonly __brand: "BootId" };

/** The shell's name for one open link during this run (section 3); never stored. */
export type LinkId = number & { readonly __brand: "LinkId" };

/** The shell's name for one control request, so its answer can find it (section 9). */
export type RequestId = number & { readonly __brand: "RequestId" };

/** The core's name for one `send` effect, so a `sendFailed` input can name it (section 2). */
export type SendRef = number & { readonly __brand: "SendRef" };

/**
 * A record's sequence number and row id: boot × 2³² + n, n counting this boot's records
 * (section 2). It grows with time, also across restarts.
 */
export type Seq = number & { readonly __brand: "Seq" };

export function deviceId(id: number): DeviceId {
  return id as DeviceId;
}

export function bootId(id: number): BootId {
  return id as BootId;
}

export function linkId(id: number): LinkId {
  return id as LinkId;
}

export function requestId(id: number): RequestId {
  return id as RequestId;
}

export function sendRef(ref: number): SendRef {
  return ref as SendRef;
}

/** How many send references each module has: its own range of the `SendRef` space. */
export const SEND_REFS_PER_MODULE = 2 ** 40;

/**
 * The `n`th send reference of `module` (section 2): (the module's place in `MODULE_ORDER` + 1) ×
 * 2⁴⁰ + n, so references are unique across modules within a run, and `sendRefModule` tells
 * whose a `sendFailed` is. References are not kept across a restart; `n` wraps within the range.
 */
export function moduleSendRef(module: ModuleName, n: number): SendRef {
  const place = MODULE_ORDER.indexOf(module) + 1;
  return sendRef(place * SEND_REFS_PER_MODULE + (n % SEND_REFS_PER_MODULE));
}

/** The module a send reference belongs to, or undefined for one no module made. */
export function sendRefModule(ref: SendRef): ModuleName | undefined {
  return MODULE_ORDER[Math.floor(ref / SEND_REFS_PER_MODULE) - 1];
}

/** A sequence number as read back from a row; `recordSeq` makes new ones. */
export function seq(value: number): Seq {
  return value as Seq;
}

/** The hub's own row in `devices` and `device_state`, whose state row is the commit mark (section 5). */
export const HUB_DEVICE: DeviceId = deviceId(0);

/** n's share of a sequence number: the boot id is multiplied by this (section 2). */
export const RECORDS_PER_BOOT = 2 ** 32;

/** The largest boot id whose sequence numbers stay exact in a double (below 2⁵³). */
export const MAX_BOOT_ID = 2 ** 21 - 1;

/**
 * The sequence number of record `n` of `boot`, or `undefined` when either is out of range: a
 * boot past MAX_BOOT_ID, or more records in one boot than 2³² (section 2).
 */
export function recordSeq(boot: BootId, n: number): Seq | undefined {
  const inRange =
    Number.isInteger(boot) &&
    boot >= 0 &&
    boot <= MAX_BOOT_ID &&
    Number.isInteger(n) &&
    n >= 0 &&
    n < RECORDS_PER_BOOT;
  return inRange ? ((boot * RECORDS_PER_BOOT + n) as Seq) : undefined;
}

/** The boot a sequence number belongs to. */
export function seqBoot(seq: Seq): BootId {
  return bootId(Math.floor(seq / RECORDS_PER_BOOT));
}
