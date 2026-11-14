/**
 * The audit module's slice (hub-design.md section 2, module 13; sections 5 and 6): the record
 * sequence, the warnings written "now" per source this hour, the rejection counts of the current
 * minute, the links' labels for `rejects.via`, the retention periods and the retention timer.
 */
import type { BootId, LinkId, Seq } from "../model/ids.ts";
import { seq } from "../model/ids.ts";
import type { RejectRow } from "../model/rows.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** D57: routine readings are kept 30 days ... */
export const D57_ROUTINE_DAYS = 30;
/** ... and events a year. */
export const D57_EVENT_DAYS = 365;

/** One source's warnings written "now" in the hour since its first (section 5, 60 an hour ‡). */
export interface WarningWindow {
  readonly since: Mono;
  readonly count: number;
  /** Whether the one warning that the cap was reached has been written. */
  readonly noticed: boolean;
}

export interface Retention {
  readonly routineDays: number;
  readonly eventDays: number;
}

export interface AuditSlice {
  readonly timers: readonly TimerOf<"audit">[];
  /**
   * The sequence number the next record of this boot takes (section 2). The dispatcher starts
   * each step's `RecordCursor` here (or at the boot's first on a `boot` input); the handler keeps
   * it at the cursor's position after every message it sees, which, audit being last, is after
   * every number any module took for the step.
   */
  readonly nextRecord: Seq;
  readonly boot: BootId | undefined;
  /** By source: `device:<id>`, `hub`, or `event:<origin>`. */
  readonly warnings: ReadonlyMap<string, WarningWindow>;
  /** The minute `rejects` counts, and its counts by `via` and reason (HB15). */
  readonly rejectMinute: number | undefined;
  readonly rejects: ReadonlyMap<string, RejectRow>;
  /** Each open link's label, for `rejects.via` when no device is known (section 6). */
  readonly links: ReadonlyMap<LinkId, string>;
  /** The links closed most recently, oldest first, whose labels `links` still keeps. */
  readonly closedLinks: readonly LinkId[];
  readonly retention: Retention;
  /** Whether the size guard is shortening history, as the writer's outcomes said (section 6). */
  readonly history: HistoryTrim;
}

/** What the audit module has said about the size guard's trimming (section 6, D110). */
export interface HistoryTrim {
  readonly trimming: boolean;
  /** The day (days since 1970) of the last warning that history is shortened. */
  readonly warnedDay: number | undefined;
  /** Whether event rows have gone during this trimming: said once, as critical. */
  readonly eventsGone: boolean;
}

export const NOT_TRIMMING: HistoryTrim = {
  trimming: false,
  warnedDay: undefined,
  eventsGone: false,
};

/** The slice before the boot event. */
export const EMPTY_AUDIT_SLICE: AuditSlice = {
  timers: [],
  nextRecord: seq(0),
  boot: undefined,
  warnings: new Map(),
  rejectMinute: undefined,
  rejects: new Map(),
  links: new Map(),
  closedLinks: [],
  retention: { routineDays: D57_ROUTINE_DAYS, eventDays: D57_EVENT_DAYS },
  history: NOT_TRIMMING,
};
