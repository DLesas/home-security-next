/**
 * What the schedules module's handler builds up while it handles one message: its slice and
 * what it emits, in order; and the writes and timers every change of the slice implies.
 */
import { ok, type Result } from "neverthrow";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { ScheduleId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { ScheduleRow } from "../model/rows.ts";
import { monoAfterMs } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import type { Entry, SchedulesSlice } from "./state.ts";

export interface Acc {
  readonly slice: SchedulesSlice;
  readonly out: readonly (Internal | Effect)[];
}

export type Step = Result<Acc, CoreFault>;

export function start(slice: SchedulesSlice): Acc {
  return { slice, out: [] };
}

export function emit(acc: Acc, ...items: readonly (Internal | Effect)[]): Acc {
  return items.length === 0 ? acc : { slice: acc.slice, out: [...acc.out, ...items] };
}

export function withSlice(acc: Acc, slice: SchedulesSlice): Acc {
  return { slice, out: acc.out };
}

/** `steps` in turn, each on the last one's result. */
export function chain(acc: Acc, ...steps: readonly ((acc: Acc) => Step)[]): Step {
  let result: Step = ok(acc);
  for (const next of steps) result = result.andThen(next);
  return result;
}

/** A `schedules` row, written now (section 3: entries and their last run). */
export function writeRow(row: ScheduleRow): Effect {
  return { kind: "write", durability: "now", op: { table: "schedules", op: "upsert", row } };
}

export function deleteRow(id: ScheduleId): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "schedules", op: "delete", key: { id } },
  };
}

export function writeZone(zone: string): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "schedule_state", op: "upsert", row: { timeZone: zone } },
  };
}

export function withEntry(slice: SchedulesSlice, entry: Entry): SchedulesSlice {
  const entries = new Map(slice.entries);
  entries.set(entry.row.id, entry);
  return { ...slice, entries };
}

/**
 * The timers the slice implies: one per entry with a next time, while the module runs, at the
 * monotonic time its next occurrence is from the anchor (HD 2: every deadline a `Mono`).
 */
export function timersOf(slice: SchedulesSlice): readonly TimerOf<"schedules">[] {
  const { anchor } = slice;
  if (anchor === undefined) return [];
  const timers: TimerOf<"schedules">[] = [];
  for (const entry of slice.entries.values()) {
    if (entry.dueMs === undefined) continue;
    timers.push({
      at: monoAfterMs(anchor.mono, entry.dueMs - anchor.wall),
      key: { module: "schedules", kind: "entryDue", schedule: entry.row.id },
    });
  }
  return timers.toSorted((a, b) => a.at - b.at || a.key.schedule - b.key.schedule);
}

function sameTimers(
  a: readonly TimerOf<"schedules">[],
  b: readonly TimerOf<"schedules">[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.at !== b[i]?.at || a[i]?.key.schedule !== b[i]?.key.schedule) return false;
  }
  return true;
}

/** The slice with its timers brought up to date; the same object when nothing changed. */
export function settled(before: SchedulesSlice, after: SchedulesSlice): SchedulesSlice {
  if (after === before) return before;
  const timers = timersOf(after);
  return sameTimers(timers, after.timers) ? after : { ...after, timers };
}
