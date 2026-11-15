/**
 * The schedules module's handler (m2-design.md section 2, module 9; section 7, "Schedules";
 * D87, D116, D117, HB13, HB31). Every message first goes through the clock checks of `clock.ts`
 * (a run whose answer never came in its step is closed first); then:
 *
 * - `boot`: the entries and the zone from the database; the watermark of D116 from the last
 *   commit mark, when its clock was trusted;
 * - `timer` (`entryDue`): the due entries run (`run.ts`);
 * - `opAnswer` to a schedule (`answerTo {kind: "schedule"}`): the answer to that run;
 * - `timeZone`: the zone, written now when it changes, and every next time found again;
 * - `downtimeKnown`: what fell due while the hub was off, when only that was still unknown;
 * - `opRequest` for schedules: `schedule.create`, `.update`, `.delete` (`ops.ts`).
 *
 * The core's purity: time comes only from `ctx.now`, wall time is trusted only through the clock
 * module's view, and the calendar is asked only through `ctx.deps.calendar`.
 */
import { ok } from "neverthrow";
import { lastCommitMark } from "../clock/view.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context, Handler } from "../model/handler.ts";
import type { Internal } from "../model/messages.ts";
import { type Acc, chain, emit, settled, start, type Step, withSlice, writeZone } from "./acc.ts";
import { followClock, onDowntimeKnown, recompute } from "./clock.ts";
import { onOpRequest } from "./ops.ts";
import { closeStale, onAnswer, onEntryTimer } from "./run.ts";
import { EMPTY_SCHEDULES_SLICE, type Entry, type SchedulesSlice } from "./state.ts";

function fromSnapshot(snapshot: DurableSnapshot, ctx: Context): SchedulesSlice {
  const entries = new Map<Entry["row"]["id"], Entry>();
  for (const row of snapshot.m2.schedules) {
    entries.set(row.id, { row, dueMs: undefined });
  }
  const mark = lastCommitMark(ctx.view);
  return {
    ...EMPTY_SCHEDULES_SLICE,
    entries,
    nextId: Math.max(0, ...snapshot.m2.schedules.map((row) => row.id)) + 1,
    zone: snapshot.m2.scheduleState?.timeZone ?? null,
    judgedThroughMs: mark?.clockOk === true ? mark.lastSeenMs : undefined,
  };
}

function onTimeZone(acc: Acc, ctx: Context, zone: string): Step {
  if (zone === acc.slice.zone) return ok(acc);
  const changed = emit(withSlice(acc, { ...acc.slice, zone }), writeZone(zone));
  // Running already: a new zone is a new definition of every local time, not a gap, so the next
  // times are found again from now. Not yet running: the clock checks start it.
  if (changed.slice.anchor !== undefined) return ok(recompute(changed, ctx, ctx.now.wall));
  return followClock(changed, ctx);
}

function onMessage(acc: Acc, message: Internal, ctx: Context): Step {
  switch (message.kind) {
    case "timer":
      return message.key.module === "schedules" ? onEntryTimer(acc, ctx) : ok(acc);
    case "opAnswer":
      return onAnswer(acc, ctx, message.answerTo, message.outcome);
    case "timeZone":
      return onTimeZone(acc, ctx, message.zone);
    case "downtimeKnown":
      return onDowntimeKnown(acc, ctx, message.downtimeMs);
    case "opRequest":
      return message.owner === "schedules" ? onOpRequest(acc, ctx, message) : ok(acc);
    default:
      return ok(acc);
  }
}

export const handleSchedules: Handler<"schedules"> = (slice, message, ctx) => {
  const first = message.kind === "boot" ? fromSnapshot(message.snapshot, ctx) : slice;
  return chain(
    start(first),
    (acc) => closeStale(acc, ctx),
    (acc) => followClock(acc, ctx),
    (acc) => (message.kind === "boot" ? ok(acc) : onMessage(acc, message, ctx)),
  ).map((acc) => ({ slice: settled(slice, acc.slice), out: acc.out }));
};
