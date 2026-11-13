/**
 * The intake module's slice (hub-design.md section 2, module 7): every device whose packets it
 * opens, by address, with its replay window and newest readings (its `device_state` row's
 * columns), the recent log entries for `repeat_of`, and the authentic copies of each siren's
 * packets heard in the last 15 minutes ‡, for the sirens module's best gateway (section 8).
 * Rejections are not kept here: each is a `rejected` message, counted per minute by audit.
 */
import type { ReplayWindow } from "@hsn/protocol";
import { type BootId, bootId, type DeviceId } from "../model/ids.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** A log entry already recorded, for marking a repeat (section 8, FD 8). */
export interface LoggedEntry {
  readonly counter: number;
  readonly level: number;
  readonly code: number;
  readonly text: string;
  /** When it was made, on this boot's clock. */
  readonly madeAt: Mono;
}

/** What intake keeps of one device. */
export interface KnownDevice {
  readonly device: DeviceId;
  readonly address: number;
  /** A protocol `Role`. */
  readonly role: number;
  readonly window: ReplayWindow;
  /** The newest status packet's body, raw, after the type byte (section 6, `device_state`). */
  readonly reading: Uint8Array | null;
  /** When the newest packet was accepted, this boot. */
  readonly heardAt: Mono | undefined;
  readonly heardMs: number | undefined;
  /** Whether `heardMs` was a trusted wall time (section 5). */
  readonly heardTrusted: boolean;
  readonly rssi: number | null;
  readonly snrQ: number | null;
  readonly bestGateway: DeviceId | null;
  /** Another module's estimates from the snapshot, kept as they were (sections 5 and 6). */
  readonly estimates: Uint8Array | null;
  readonly logs: readonly LoggedEntry[];
}

/** One authentic copy of a siren's packet, duplicates included (section 8). */
export interface HeardCopy {
  readonly gateway: DeviceId;
  readonly snrQuarterDb: number;
  readonly at: Mono;
}

export interface IntakeSlice {
  readonly timers: readonly TimerOf<"intake">[];
  readonly boot: BootId;
  readonly byAddress: ReadonlyMap<number, DeviceId>;
  readonly devices: ReadonlyMap<DeviceId, KnownDevice>;
  readonly copies: ReadonlyMap<DeviceId, readonly HeardCopy[]>;
}

/** The slice before the boot event. */
export const EMPTY_INTAKE_SLICE: IntakeSlice = {
  timers: [],
  boot: bootId(0),
  byAddress: new Map(),
  devices: new Map(),
  copies: new Map(),
};
