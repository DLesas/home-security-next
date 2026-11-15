/**
 * The schedules module's slice (m2-design.md section 2, module 9; section 7, "Schedules"): the
 * entries with each one's next time, the hub's time zone, and what the module knows of the wall
 * clock.
 *
 * Wall time decides only which occurrence is due, and only while it is trusted; every timer is a
 * monotonic deadline (HD 2): an entry's next occurrence `dueMs`, a wall time from the calendar,
 * becomes `anchor.mono` plus its distance from `anchor.wall`, the trusted reading it was counted
 * from. While the clock is untrusted, or before the zone is known, there is no anchor, no next
 * time and no timer.
 *
 * `judgedThroughMs` is the watermark of D116: every occurrence of every entry at or before it has
 * run or been recorded as missed. It is the last commit's wall time at a start whose last commit
 * was on a trusted clock, and is held while the clock is untrusted; when the module can judge
 * again, every occurrence after it and up to now is missed, never run late.
 */
import type { DeviceId, ScheduleId, Seq } from "../model/ids.ts";
import type { ScheduleRow } from "../model/rows.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** Why an occurrence was missed (D116; the app's `scheduleObject.missed.why`). */
export type MissedWhy = "hubOff" | "clockNotSet" | "clockStepped";

/**
 * An entry. Its last miss is in its row (`missed_due_ms`, `missed_why`, `missed_count`), so it
 * survives a restart and shows until the entry next runs (section 7).
 */
export interface Entry {
  readonly row: ScheduleRow;
  /** The next occurrence to run, wall milliseconds; undefined while there is none to wait for. */
  readonly dueMs: number | undefined;
}

/** A trusted wall reading and the monotonic time it was taken at. */
export interface Anchor {
  readonly mono: Mono;
  readonly wall: number;
}

/**
 * A run whose request is with its owner, by the record its `answerTo` names: the `opAnswer` that
 * comes back names the same schedule and record (`AnswerTo`'s schedule variant).
 */
export interface InFlight {
  readonly schedule: ScheduleId;
  /** The number taken for its `schedule_ran` decision, which the arming's decisions name. */
  readonly record: Seq;
  /** The step it was sent in: an answer cannot come in a later one. */
  readonly stepMono: Mono;
  /** The sensor named by the entry, if it names one. */
  readonly sensor: DeviceId | undefined;
  readonly action: ScheduleRow["action"];
}

export interface SchedulesSlice {
  /** One `entryDue` per entry with a next time, while the module runs. */
  readonly timers: readonly TimerOf<"schedules">[];
  readonly entries: ReadonlyMap<ScheduleId, Entry>;
  /** The id the next entry made gets. */
  readonly nextId: number;
  /** The hub's time zone, from `timeZone` (`schedule_state.time_zone`), null before the first. */
  readonly zone: string | null;
  /** Set while the module runs: the clock trusted and the zone known. */
  readonly anchor: Anchor | undefined;
  /** D116's watermark (above); undefined while unknown. */
  readonly judgedThroughMs: number | undefined;
  /** This run's start in trusted wall time, once known: occurrences before it, the hub was off. */
  readonly startedWallMs: number | undefined;
  /**
   * Set when judging began at this run's start because the last commit's clock was untrusted:
   * a downtime known later (`downtimeKnown`) says how far back the hub was off.
   */
  readonly unjudgedBeforeMs: number | undefined;
  /** `schedules_waiting_for_clock` raised for this untrusted stretch (once, section 7). */
  readonly waitingWarned: boolean;
  /** Runs whose answers have not come yet, by their record. */
  readonly inFlight: ReadonlyMap<Seq, InFlight>;
}

/** The slice before the boot event. */
export const EMPTY_SCHEDULES_SLICE: SchedulesSlice = {
  timers: [],
  entries: new Map(),
  nextId: 1,
  zone: null,
  anchor: undefined,
  judgedThroughMs: undefined,
  startedWallMs: undefined,
  unjudgedBeforeMs: undefined,
  waitingWarned: false,
  inFlight: new Map(),
};
