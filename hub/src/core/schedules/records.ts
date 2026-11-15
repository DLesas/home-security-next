/**
 * The schedules module's decisions (m2-design.md section 7, "Schedules"; D110), laid out here as
 * section 11 asks of each M2 owner: `device_id`, `value` and `detail` exactly, so a program
 * reading the records never guesses. Integers little-endian; a device list is a u16 count, then
 * each device number as u32. Every one is written now (section 3): `schedule_ran` in the commit
 * of the arming it caused, the others as warnings.
 *
 * | Kind | `device_id` | `value` | `detail` | `cause_seq` |
 * | --- | --- | --- | --- | --- |
 * | `schedule_ran` | the sensor the entry names, else null | the entry's id | action u8 (0 switch to a mode, 1 arm, 2 disarm); outcome u8 (0 done, 1 refused, 2 no answer); then four device lists: armed, disarmed, left waiting for the door, found low; then, when refused, the error code as UTF-8 | null |
 * | `schedule_held_back` | as `schedule_ran` | the entry's id | the sensors left armed, u32 each (D117) | its `schedule_ran` |
 * | `schedule_missed` | as `schedule_ran` | the entry's id | why u8 (0 the hub was off, 1 its clock was not set, 2 its clock stepped forward over it, as `schedules.missed_why`); count u32; the first and the last occurrence, wall milliseconds, u64 each (21 bytes) | null |
 * | `schedules_waiting_for_clock` | null | 1 when what fell due before this start cannot be told (the last commit's clock was not set either), else 0 | — | null |
 */
import { err, ok, type Result } from "neverthrow";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, ScheduleId, Seq } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { ScheduleAction } from "../model/rows.ts";
import { decision, recordMessage } from "../util/records.ts";
import type { MissedWhy } from "./state.ts";

const U32 = 2 ** 32;

/** What came of a run's request (`schedule_ran`'s outcome byte). */
export const RunOutcome = { Done: 0, Refused: 1, NoAnswer: 2 } as const;
export type RunOutcome = (typeof RunOutcome)[keyof typeof RunOutcome];

/** What a run did, from its answer (section 7: what it armed, disarmed, left waiting, found low). */
export interface RunResult {
  readonly outcome: RunOutcome;
  readonly armed: readonly DeviceId[];
  readonly disarmed: readonly DeviceId[];
  readonly waiting: readonly DeviceId[];
  readonly low: readonly DeviceId[];
  /** The refusal's error code, when refused. */
  readonly error: string | undefined;
}

export const WHY_CODES: Readonly<Record<MissedWhy, number>> = {
  hubOff: 0,
  clockNotSet: 1,
  clockStepped: 2,
};

class Bytes {
  readonly #bytes: number[] = [];
  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }
  u16(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }
  u32(value: number): this {
    return this.u16(value & 0xffff).u16(value >>> 16);
  }
  /** An integer below 2⁵³, as eight bytes. */
  u64(value: number): this {
    const high = Math.floor(value / U32);
    return this.u32(value - high * U32).u32(high);
  }
  devices(devices: readonly DeviceId[]): this {
    this.u16(devices.length);
    for (const device of devices) this.u32(device);
    return this;
  }
  text(text: string): this {
    for (const byte of new TextEncoder().encode(text)) this.u8(byte);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

export function ranDetail(action: ScheduleAction, result: RunResult): Uint8Array {
  const bytes = new Bytes()
    .u8(action)
    .u8(result.outcome)
    .devices(result.armed)
    .devices(result.disarmed)
    .devices(result.waiting)
    .devices(result.low);
  if (result.error !== undefined) bytes.text(result.error);
  return bytes.done();
}

export function heldBackDetail(sensors: readonly DeviceId[]): Uint8Array {
  const bytes = new Bytes();
  for (const sensor of sensors) bytes.u32(sensor);
  return bytes.done();
}

export function missedDetail(
  why: MissedWhy,
  count: number,
  firstMs: number,
  lastMs: number,
): Uint8Array {
  return new Bytes().u8(WHY_CODES[why]).u32(count).u64(firstMs).u64(lastMs).done();
}

/**
 * `schedule_ran` under the number taken when the run's request went out, so the arming's own
 * decisions could name it as their cause before it was written (HD 2, `records`).
 */
export function ranRecord(
  ctx: Context,
  record: Seq,
  fields: {
    readonly schedule: ScheduleId;
    readonly sensor: DeviceId | undefined;
    readonly action: ScheduleAction;
    readonly result: RunResult;
  },
): Internal {
  return recordMessage("now", {
    kind: "decision",
    row: {
      seq: record,
      atMs: ctx.now.wall,
      clockOk: ctx.now.wallTrusted,
      kind: "schedule_ran",
      deviceId: fields.sensor ?? null,
      causeSeq: null,
      value: fields.schedule,
      detail: ranDetail(fields.action, fields.result),
    },
  });
}

export function heldBackRecord(
  ctx: Context,
  fields: {
    readonly schedule: ScheduleId;
    readonly sensor: DeviceId | undefined;
    readonly cause: Seq;
    readonly sensors: readonly DeviceId[];
  },
): Result<Internal, CoreFault> {
  return decision(ctx, "now", {
    kind: "schedule_held_back",
    device: fields.sensor,
    cause: fields.cause,
    value: fields.schedule,
    detail: heldBackDetail(fields.sensors),
  }).map((decided) => decided.message);
}

export function missedRecord(
  ctx: Context,
  fields: {
    readonly schedule: ScheduleId;
    readonly sensor: DeviceId | undefined;
    readonly why: MissedWhy;
    readonly count: number;
    readonly firstMs: number;
    readonly lastMs: number;
  },
): Result<Internal, CoreFault> {
  return decision(ctx, "now", {
    kind: "schedule_missed",
    device: fields.sensor,
    cause: null,
    value: fields.schedule,
    detail: missedDetail(fields.why, fields.count, fields.firstMs, fields.lastMs),
  }).map((decided) => decided.message);
}

export function waitingRecord(ctx: Context, cannotTell: boolean): Result<Internal, CoreFault> {
  return decision(ctx, "now", {
    kind: "schedules_waiting_for_clock",
    device: null,
    cause: null,
    value: cannotTell ? 1 : 0,
  }).map((decided) => decided.message);
}

/** Each result in turn, or the first fault. */
export function all<T>(results: readonly Result<T, CoreFault>[]): Result<readonly T[], CoreFault> {
  const values: T[] = [];
  for (const result of results) {
    if (result.isErr()) return err(result.error);
    values.push(result.value);
  }
  return ok(values);
}
