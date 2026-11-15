/**
 * Running entries (m2-design.md section 7, "Schedules"; section 11, "Step 1's questions,
 * settled"; D87, D117, AL7, AL12):
 *
 * - **Due.** At an entry's timer, every entry whose next occurrence the trusted wall clock has
 *   reached is due, in the order of the minute it is due in, then of its id ‡. Each gets its last
 *   run (wall time, and the occurrence's local date) and no miss any more, written now, and its
 *   next time found after the occurrence. The row is written in this step, so in the same commit
 *   as the arming its request causes (section 3): after a power cut it neither runs again nor is
 *   lost.
 * - **The request.** The entry's action goes to its owner (`OP_OWNERS`: layout) as an
 *   `opRequest` with the actor "schedule <name>" and the schedule's own authority (`Actor` of kind
 *   `schedule`, which never asks for confirmation), answered to the schedule: `answerTo {kind:
 *   "schedule", schedule, record}`, `record` the number taken for the entry's `schedule_ran`,
 *   which the arming's decisions name as their cause.
 * - **The answer** (alarm's `opAnswer`, in the same step) gives `schedule_ran`: what the run
 *   armed, disarmed, left waiting for its door and found low, from the reply's lists (`mode.switch`
 *   and `arm`: `armed`, `disarmed`, `waiting`, `lowBattery`; `disarm`: `disarmed`); and, when the
 *   reply names sensors in `heldBack` (D117), `schedule_held_back` naming them.
 *
 * `mode.switch`'s reply carries `heldBack` too (section 11, settled): it is read from the reply of
 * every run but an arm.
 */
import { ok } from "neverthrow";
import type { AppOp } from "@hsn/protocol/app";
import type { Context } from "../model/handler.ts";
import { type DeviceId, deviceId } from "../model/ids.ts";
import type { AnswerTo, Internal, OpOutcome } from "../model/messages.ts";
import { ScheduleAction, type ScheduleRow } from "../model/rows.ts";
import { type Acc, chain, emit, type Step, withEntry, withSlice, writeRow } from "./acc.ts";
import { sensorOf } from "./clock.ts";
import { localDay, nextAfter, targetOf, withoutMissed } from "./entries.ts";
import { heldBackRecord, ranRecord, RunOutcome, type RunResult } from "./records.ts";
import type { Entry, InFlight } from "./state.ts";

const MINUTE_MS = 60_000;

/** The entries the trusted wall clock says are due now, in the order they run in. */
function dueEntries(acc: Acc, ctx: Context): readonly Entry[] {
  return [...acc.slice.entries.values()]
    .filter((entry) => entry.dueMs !== undefined && entry.dueMs <= ctx.now.wall)
    .toSorted(
      (a, b) =>
        Math.floor((a.dueMs ?? 0) / MINUTE_MS) - Math.floor((b.dueMs ?? 0) / MINUTE_MS) ||
        a.row.id - b.row.id,
    );
}

function opOf(row: ScheduleRow): AppOp | undefined {
  const target = targetOf(row);
  if (target === undefined) return undefined;
  if (row.action === ScheduleAction.SwitchMode) {
    return "mode" in target ? { op: "mode.switch", body: { mode: target.mode } } : undefined;
  }
  if ("mode" in target) return undefined;
  return row.action === ScheduleAction.Arm
    ? { op: "arm", body: { target } }
    : { op: "disarm", body: { target } };
}

const EMPTY_RESULT: RunResult = {
  outcome: RunOutcome.Done,
  armed: [],
  disarmed: [],
  waiting: [],
  low: [],
  error: undefined,
};

/** One due entry: its row written, its request sent (or, with no request to send, refused). */
function runOne(acc: Acc, ctx: Context, entry: Entry, zone: string): Step {
  const dueMs = entry.dueMs ?? ctx.now.wall;
  const row: ScheduleRow = withoutMissed({
    ...entry.row,
    lastRunMs: ctx.now.wall,
    lastRunLocalDate: localDay(ctx.deps.calendar, dueMs, zone),
  });
  const after = Math.max(dueMs, acc.slice.judgedThroughMs ?? dueMs);
  const ran: Entry = { row, dueMs: nextAfter(ctx.deps.calendar, row, zone, after) };
  const written = emit(withSlice(acc, withEntry(acc.slice, ran)), writeRow(row));
  return ctx.records.take().map((record) => {
    const sensor = sensorOf(ran);
    const op = opOf(row);
    if (op === undefined) {
      // A row whose target does not fit its action: recorded as refused, nothing sent.
      return emit(
        written,
        ranRecord(ctx, record, {
          schedule: row.id,
          sensor,
          action: row.action,
          result: { ...EMPTY_RESULT, outcome: RunOutcome.Refused, error: "invalid" },
        }),
      );
    }
    const inFlight = new Map(written.slice.inFlight);
    const flight: InFlight = {
      schedule: row.id,
      record,
      stepMono: ctx.now.mono,
      sensor,
      action: row.action,
    };
    inFlight.set(record, flight);
    const request: Internal = {
      kind: "opRequest",
      owner: "layout",
      op,
      actor: { kind: "schedule", schedule: row.id, name: `schedule ${row.name}` },
      answerTo: { kind: "schedule", schedule: row.id, record },
      record,
    };
    return emit(withSlice(written, { ...written.slice, inFlight }), request);
  });
}

/**
 * An entry's timer. Wall time decides which entries are due; a timer that finds none (it fired
 * early, as a clock slewed back) only moves the anchor, so it is set again for the right time.
 */
export function onEntryTimer(acc: Acc, ctx: Context): Step {
  const { slice } = acc;
  const { zone } = slice;
  if (slice.anchor === undefined || zone === null) return ok(acc);
  const due = dueEntries(acc, ctx);
  if (due.length === 0) {
    return ok(withSlice(acc, { ...slice, anchor: { mono: ctx.now.mono, wall: ctx.now.wall } }));
  }
  return chain(acc, ...due.map((entry) => (a: Acc) => runOne(a, ctx, entry, zone)));
}

/** A device list in a reply's body, or undefined. */
function devicesIn(body: unknown, key: string): readonly DeviceId[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value: unknown = Reflect.get(body, key);
  if (!Array.isArray(value)) return undefined;
  const items: readonly unknown[] = value;
  return items.every((item) => typeof item === "number" && Number.isInteger(item) && item > 0)
    ? items.map((item) => deviceId(Number(item)))
    : undefined;
}

function resultOf(outcome: OpOutcome): RunResult {
  if (!outcome.ok) {
    return { ...EMPTY_RESULT, outcome: RunOutcome.Refused, error: outcome.error.code };
  }
  const { body } = outcome;
  return {
    outcome: RunOutcome.Done,
    armed: devicesIn(body, "armed") ?? [],
    disarmed: devicesIn(body, "disarmed") ?? [],
    waiting: devicesIn(body, "waiting") ?? [],
    low: devicesIn(body, "lowBattery") ?? [],
    error: undefined,
  };
}

/** A run's answer, or none: its `schedule_ran` and any `schedule_held_back`. */
function finish(acc: Acc, ctx: Context, flight: InFlight, outcome: OpOutcome | undefined): Step {
  const inFlight = new Map(acc.slice.inFlight);
  inFlight.delete(flight.record);
  const result =
    outcome === undefined ? { ...EMPTY_RESULT, outcome: RunOutcome.NoAnswer } : resultOf(outcome);
  const ran = ranRecord(ctx, flight.record, {
    schedule: flight.schedule,
    sensor: flight.sensor,
    action: flight.action,
    result,
  });
  const done = emit(withSlice(acc, { ...acc.slice, inFlight }), ran);
  const held = outcome?.ok === true ? (devicesIn(outcome.body, "heldBack") ?? []) : [];
  if (held.length === 0 || flight.action === ScheduleAction.Arm) return ok(done);
  return heldBackRecord(ctx, {
    schedule: flight.schedule,
    sensor: flight.sensor,
    cause: flight.record,
    sensors: held,
  }).map((message) => emit(done, message));
}

/** An answer to one of this module's runs: the run it names, by its record. */
export function onAnswer(acc: Acc, ctx: Context, answerTo: AnswerTo, outcome: OpOutcome): Step {
  if (answerTo.kind !== "schedule") return ok(acc);
  const flight = acc.slice.inFlight.get(answerTo.record);
  if (flight?.schedule !== answerTo.schedule) return ok(acc);
  return finish(acc, ctx, flight, outcome);
}

/** Runs still in flight from an earlier step got no answer: recorded so. */
export function closeStale(acc: Acc, ctx: Context): Step {
  const stale: InFlight[] = [];
  for (const flight of acc.slice.inFlight.values()) {
    if (flight.stepMono !== ctx.now.mono) stale.push(flight);
  }
  if (stale.length === 0) return ok(acc);
  return chain(acc, ...stale.map((flight) => (a: Acc) => finish(a, ctx, flight, undefined)));
}
