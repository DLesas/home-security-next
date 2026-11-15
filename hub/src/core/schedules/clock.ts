/**
 * The wall clock as schedules see it (m2-design.md section 7, "Schedules": its next time, an
 * untrusted clock, missed entries; D116; HD 5, "The clock"), checked at every message before
 * anything else:
 *
 * - **Starting.** When the clock is trusted and the zone known, the module runs: every
 *   occurrence after the watermark (`judgedThroughMs`) and up to now is missed, never run late
 *   (D116), one `schedule_missed` per entry and reason; each entry's next time is found after
 *   now, and becomes a monotonic deadline from now's reading (the anchor).
 * - **Stopping.** When the clock stops being trusted, the module stops: no next times, no
 *   timers, one `schedules_waiting_for_clock` (section 7) while an entry is enabled; the
 *   watermark holds at the last occurrence that could still be judged.
 * - **Stepping while trusted.** The wall clock is compared with the anchor's reading carried
 *   forward on the monotonic clock. A step forwards of more than `clockStepMs` ‡ jumps over
 *   time no entry was given: an occurrence inside the jump is missed, never run late; one that
 *   the time actually elapsed reached still runs, at its timer. A step backwards finds each
 *   entry's next time again from the new reading; the local date of its last run keeps one
 *   that already ran from running twice. Smaller differences (a clock being slewed) only move
 *   the anchor, past `reanchorMs` ‡.
 * - **Why missed.** An occurrence before this run's start, in trusted wall time, was missed
 *   because the hub was off; one after it, because its clock was not set; one a step forwards
 *   jumped over, because the clock stepped (D116's three reasons). Each entry keeps its last miss
 *   in its row, written now with the decision, so it shows after a restart.
 *
 * The two thresholds are `HubRules.schedules.clockStepMs` and `reanchorMs`.
 */
import { ok, type Result } from "neverthrow";
import { downtime, startedAt, wallTrusted } from "../clock/view.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { msBetween } from "../model/time.ts";
import { type Acc, chain, emit, type Step, withSlice, writeRow } from "./acc.ts";
import { byId, localDay, nextAfter, ruleOf, targetOf, withMissed } from "./entries.ts";
import { all, missedRecord, waitingRecord } from "./records.ts";
import type { Entry, MissedWhy, SchedulesSlice } from "./state.ts";

/** The most occurrences of one entry counted in one gap: over 27 years of a daily entry. */
export const MAX_COUNTED = 10_000;

/** What the anchor's reading says the wall clock should read now. */
export function expectedWall(slice: SchedulesSlice, ctx: Context): number | undefined {
  const { anchor } = slice;
  return anchor === undefined ? undefined : anchor.wall + msBetween(anchor.mono, ctx.now.mono);
}

/** Whether the module can run: a trusted clock and a zone. */
function canRun(slice: SchedulesSlice, ctx: Context): boolean {
  return slice.zone !== null && wallTrusted(ctx.view, ctx.now);
}

/** The occurrences of an entry in (`fromMs`, `toMs`] that never ran, earliest first. */
function occurrencesIn(
  ctx: Context,
  entry: Entry,
  zone: string,
  fromMs: number,
  toMs: number,
): readonly number[] {
  const rule = ruleOf(entry.row);
  if (rule === undefined || !entry.row.enabled || toMs <= fromMs) return [];
  const { calendar } = ctx.deps;
  const found: number[] = [];
  let next = calendar.next(rule, zone, fromMs + 1);
  while (next !== undefined && next <= toMs && found.length < MAX_COUNTED) {
    if (localDay(calendar, next, zone) !== entry.row.lastRunLocalDate) found.push(next);
    next = calendar.next(rule, zone, next + 1);
  }
  return found;
}

/**
 * Every occurrence in (`fromMs`, `toMs`] is missed (D116): one decision per entry and reason
 * (several occurrences of one entry in one gap give one, with their count and the first and
 * last ‡), and the entry's row keeps the latest, written now. `why` gives each occurrence's reason.
 */
export function judgeGap(
  acc: Acc,
  ctx: Context,
  fromMs: number,
  toMs: number,
  why: (ms: number) => MissedWhy,
): Step {
  const { zone } = acc.slice;
  if (zone === null || toMs <= fromMs) return ok(acc);
  const records: Result<Internal, CoreFault>[] = [];
  const writes: ReturnType<typeof writeRow>[] = [];
  const entries = new Map(acc.slice.entries);
  for (const entry of byId(acc.slice.entries.values())) {
    const found = occurrencesIn(ctx, entry, zone, fromMs, toMs);
    if (found.length === 0) continue;
    const sensor = sensorOf(entry);
    let row = entry.row;
    for (const reason of MISSED_WHYS) {
      const some = found.filter((ms) => why(ms) === reason);
      const first = some[0];
      const last = some.at(-1);
      if (first === undefined || last === undefined) continue;
      records.push(
        missedRecord(ctx, {
          schedule: entry.row.id,
          sensor,
          why: reason,
          count: some.length,
          firstMs: first,
          lastMs: last,
        }),
      );
      // The reasons follow one another in time, so the last one written is the latest.
      row = withMissed(row, { lastMs: last, why: reason, count: some.length });
    }
    entries.set(entry.row.id, { ...entry, row });
    writes.push(writeRow(row));
  }
  return all(records).map((messages) =>
    emit(withSlice(acc, { ...acc.slice, entries }), ...writes, ...messages),
  );
}

const MISSED_WHYS = [
  "hubOff",
  "clockNotSet",
  "clockStepped",
] as const satisfies readonly MissedWhy[];

/** The reason of a gap that ends this run's time off: hub off before `startedMs`, else clock not set. */
function offOrUnset(startedMs: number | undefined): (ms: number) => MissedWhy {
  return (ms) => (startedMs !== undefined && ms <= startedMs ? "hubOff" : "clockNotSet");
}

export function sensorOf(entry: Entry): DeviceId | undefined {
  const target = targetOf(entry.row);
  return target !== undefined && "sensor" in target ? target.sensor : undefined;
}

/** Each entry's next time after `afterMs`, judged through it, and the anchor at now. */
export function recompute(acc: Acc, ctx: Context, afterMs: number): Acc {
  const { zone } = acc.slice;
  const entries = new Map<Entry["row"]["id"], Entry>();
  for (const [id, entry] of acc.slice.entries) {
    entries.set(id, { ...entry, dueMs: nextAfter(ctx.deps.calendar, entry.row, zone, afterMs) });
  }
  return withSlice(acc, {
    ...acc.slice,
    entries,
    anchor: { mono: ctx.now.mono, wall: ctx.now.wall },
    judgedThroughMs: afterMs,
  });
}

/** The anchor moved to now, each next time kept. */
function reanchor(acc: Acc, ctx: Context): Acc {
  return withSlice(acc, { ...acc.slice, anchor: { mono: ctx.now.mono, wall: ctx.now.wall } });
}

function anyEnabled(slice: SchedulesSlice): boolean {
  return [...slice.entries.values()].some((entry) => entry.row.enabled);
}

/** `schedules_waiting_for_clock`, once per untrusted stretch, while an entry is enabled. */
export function warnWaiting(acc: Acc, ctx: Context): Step {
  const { slice } = acc;
  if (slice.waitingWarned || slice.anchor !== undefined || !anyEnabled(slice)) return ok(acc);
  if (wallTrusted(ctx.view, ctx.now)) return ok(acc);
  const cannotTell = slice.judgedThroughMs === undefined && downtime(ctx.view).kind === "unknown";
  return waitingRecord(ctx, cannotTell).map((message) =>
    emit(withSlice(acc, { ...slice, waitingWarned: true }), message),
  );
}

/** This run's start in trusted wall time, counted back from now on the monotonic clock. */
function startedWall(slice: SchedulesSlice, ctx: Context): number {
  if (slice.startedWallMs !== undefined) return slice.startedWallMs;
  const started = startedAt(ctx.view) ?? ctx.now.mono;
  return ctx.now.wall - msBetween(started, ctx.now.mono);
}

/** The clock is trusted and the zone known: judge what fell due meanwhile, then run. */
function startRunning(acc: Acc, ctx: Context): Step {
  const { slice } = acc;
  const started = startedWall(slice, ctx);
  let fromMs = slice.judgedThroughMs;
  let unjudgedBeforeMs: number | undefined;
  if (fromMs === undefined) {
    const off = downtime(ctx.view);
    if (off.kind === "known") {
      fromMs = started - off.ms;
    } else {
      fromMs = started;
      // The last commit's clock was untrusted: before this start, nothing can be told yet.
      unjudgedBeforeMs = off.kind === "unknown" ? started : undefined;
    }
  }
  const judgedFrom = fromMs;
  return judgeGap(acc, ctx, judgedFrom, ctx.now.wall, offOrUnset(started)).map((judged) => {
    const ran = recompute(judged, ctx, ctx.now.wall);
    return withSlice(ran, {
      ...ran.slice,
      judgedThroughMs: ctx.now.wall,
      startedWallMs: started,
      unjudgedBeforeMs,
      waitingWarned: false,
    });
  });
}

/**
 * The clock stopped being trusted: every occurrence before the earliest next time has run, so
 * the watermark holds there, or at what the anchor says it is now if that is earlier.
 */
function stopRunning(acc: Acc, ctx: Context): Step {
  const { slice } = acc;
  const expected = expectedWall(slice, ctx) ?? ctx.now.wall;
  const nextTimes = [...slice.entries.values()].flatMap((entry) =>
    entry.dueMs === undefined ? [] : [entry.dueMs],
  );
  const earliest = nextTimes.length === 0 ? undefined : Math.min(...nextTimes);
  const watermark = earliest === undefined ? expected : Math.min(expected, earliest - 1);
  const entries = new Map<Entry["row"]["id"], Entry>();
  for (const [id, entry] of slice.entries) entries.set(id, { ...entry, dueMs: undefined });
  return warnWaiting(
    withSlice(acc, {
      ...slice,
      entries,
      anchor: undefined,
      judgedThroughMs: Math.max(watermark, slice.judgedThroughMs ?? watermark),
    }),
    ctx,
  );
}

/** A trusted clock that has moved against the monotonic clock's count (above). */
function followSteps(acc: Acc, ctx: Context): Step {
  const expected = expectedWall(acc.slice, ctx);
  if (expected === undefined) return ok(acc);
  const drift = ctx.now.wall - expected;
  const { clockStepMs, reanchorMs } = ctx.deps.rules.schedules;
  if (Math.abs(drift) <= reanchorMs) return ok(acc);
  if (drift > clockStepMs) {
    // Jumped over (expected, now]: what fell in it is missed. An entry whose time the
    // elapsed time reached keeps it and runs at its timer, due in this very step.
    return judgeGap(acc, ctx, expected, ctx.now.wall, () => "clockStepped").map((judged) => {
      const entries = new Map<Entry["row"]["id"], Entry>();
      for (const [id, entry] of judged.slice.entries) {
        const keep = entry.dueMs !== undefined && entry.dueMs <= expected;
        entries.set(id, {
          ...entry,
          dueMs: keep
            ? entry.dueMs
            : nextAfter(ctx.deps.calendar, entry.row, judged.slice.zone, ctx.now.wall),
        });
      }
      return withSlice(judged, {
        ...judged.slice,
        entries,
        anchor: { mono: ctx.now.mono, wall: ctx.now.wall },
        judgedThroughMs: ctx.now.wall,
      });
    });
  }
  if (drift < -clockStepMs) return ok(recompute(acc, ctx, ctx.now.wall));
  return ok(reanchor(acc, ctx));
}

/** The clock checks of every message (above), before the message itself. */
export function followClock(acc: Acc, ctx: Context): Step {
  const running = acc.slice.anchor !== undefined;
  const can = canRun(acc.slice, ctx);
  if (!running && can) return startRunning(acc, ctx);
  if (running && !can) return stopRunning(acc, ctx);
  if (running) return followSteps(acc, ctx);
  return warnWaiting(acc, ctx);
}

/**
 * The downtime became known (D113) after judging began at this start because the last commit's
 * clock was untrusted: what fell due while the hub was off is missed too.
 */
export function onDowntimeKnown(acc: Acc, ctx: Context, downtimeMs: number): Step {
  const before = acc.slice.unjudgedBeforeMs;
  if (before === undefined || acc.slice.anchor === undefined) return ok(acc);
  return chain(
    acc,
    (a) => judgeGap(a, ctx, before - downtimeMs, before, () => "hubOff"),
    (a) => ok(withSlice(a, { ...a.slice, unjudgedBeforeMs: undefined })),
  );
}
