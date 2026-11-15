/**
 * Entries and their next times (m2-design.md section 7, "Schedules"): the calendar rule of a
 * `schedules` row, the next occurrence after a wall time, kept to at most one run per local date,
 * and an entry as the app's `scheduleObject` carries it (section 6).
 */
import type { ScheduleObject } from "@hsn/protocol/app";
import { type CalendarRule, type DaySet, type LocalDate } from "../model/calendar.ts";
import type { CoreDeps } from "../model/handler.ts";
import { type DeviceId, type GroupId, type ModeId, type ScheduleId } from "../model/ids.ts";
import { MissedWhy as MissedCode, ScheduleAction, type ScheduleRow } from "../model/rows.ts";
import {
  civilFromDays,
  daysFromCivil,
  textOfDate,
  textOfMinutes,
  timeOfMinutes,
  weekdaysOfBits,
} from "./days.ts";
import type { Entry, MissedWhy } from "./state.ts";

/** The row's rule for the calendar: its local time, on its weekdays or once on its date. */
export function ruleOf(row: ScheduleRow): CalendarRule | undefined {
  const at = timeOfMinutes(row.localTime);
  if (row.date !== null) return { at, days: { date: civilFromDays(row.date) } };
  return row.days === 0 ? undefined : { at, days: row.days as DaySet };
}

/** The local date of a wall instant in the zone, as days since 1970-01-01. */
export function localDay(calendar: CoreDeps["calendar"], ms: number, zone: string): number {
  return daysFromCivil(calendar.local(ms, zone).date);
}

/**
 * The first occurrence after `afterMs` (so not at it: everything up to it has been run or judged)
 * that may still run: never on the local date it last ran (section 7, "An entry runs at most once
 * per local date"), which is what keeps a clock that steps back from running it again. The
 * calendar already gives one instant per date: a skipped time at the first minute after the jump
 * on that date, a repeated one at its first, a skipped date none.
 */
export function nextAfter(
  calendar: CoreDeps["calendar"],
  row: ScheduleRow,
  zone: string | null,
  afterMs: number,
): number | undefined {
  if (!row.enabled || zone === null) return undefined;
  const rule = ruleOf(row);
  if (rule === undefined) return undefined;
  const next = calendar.next(rule, zone, afterMs + 1);
  if (next === undefined || row.lastRunLocalDate === null) return next;
  if (localDay(calendar, next, zone) !== row.lastRunLocalDate) return next;
  // The calendar names one instant per local date, so from just after it is the next date's.
  return calendar.next(rule, zone, next + 1);
}

/** The target an entry names, by its action. */
export type Target =
  { readonly mode: ModeId } | { readonly group: GroupId } | { readonly sensor: DeviceId };

export function targetOf(row: ScheduleRow): Target | undefined {
  if (row.action === ScheduleAction.SwitchMode) {
    return row.modeId === null ? undefined : { mode: row.modeId };
  }
  if (row.groupId !== null) return { group: row.groupId };
  return row.sensorId === null ? undefined : { sensor: row.sensorId };
}

const ACTION_NAMES = {
  [ScheduleAction.SwitchMode]: "switchMode",
  [ScheduleAction.Arm]: "arm",
  [ScheduleAction.Disarm]: "disarm",
} as const satisfies Record<ScheduleAction, ScheduleObject["action"]>;

export function actionName(action: ScheduleAction): ScheduleObject["action"] {
  return ACTION_NAMES[action];
}

function daysOf(row: ScheduleRow): ScheduleObject["days"] {
  if (row.date !== null) return { date: textOfDate(civilFromDays(row.date)) };
  return weekdaysOfBits(row.days);
}

const WHY_OF_CODE = {
  [MissedCode.HubOff]: "hubOff",
  [MissedCode.ClockNotSet]: "clockNotSet",
  [MissedCode.ClockStepped]: "clockStepped",
} as const satisfies Record<MissedCode, MissedWhy>;

const CODE_OF_WHY = {
  hubOff: MissedCode.HubOff,
  clockNotSet: MissedCode.ClockNotSet,
  clockStepped: MissedCode.ClockStepped,
} as const satisfies Record<MissedWhy, MissedCode>;

/** The row's last miss, as the app shows it; null when it has none (D116). */
export function missedOf(row: ScheduleRow): ScheduleObject["missed"] {
  if (row.missedDueMs === null || row.missedWhy === null || row.missedCount < 1) return null;
  return { dueMs: row.missedDueMs, why: WHY_OF_CODE[row.missedWhy], count: row.missedCount };
}

/**
 * The row with more misses (section 4, `schedules.missed_*`, as section 11 settles it): the last
 * occurrence missed and why, and the count of every miss since the entry last ran, so the app
 * shows "missed at 22:00, and 2 earlier".
 */
export function withMissed(
  row: ScheduleRow,
  missed: { readonly lastMs: number; readonly why: MissedWhy; readonly count: number },
): ScheduleRow {
  return {
    ...row,
    missedDueMs: missed.lastMs,
    missedWhy: CODE_OF_WHY[missed.why],
    missedCount: row.missedCount + missed.count,
  };
}

/** The row with no miss: it has run since (section 7: shown until the entry next runs). */
export function withoutMissed(row: ScheduleRow): ScheduleRow {
  return { ...row, missedDueMs: null, missedWhy: null, missedCount: 0 };
}

/** An entry as the app sees it (section 6, `scheduleObject`). */
export function scheduleObjectOf(entry: Entry): ScheduleObject {
  const { row } = entry;
  const target = targetOf(row) ?? { sensor: 0 };
  return {
    id: row.id,
    name: row.name,
    action: actionName(row.action),
    target,
    at: textOfMinutes(row.localTime),
    days: daysOf(row),
    enabled: row.enabled,
    nextMs: entry.dueMs ?? null,
    missed: missedOf(row),
    revision: row.revision,
  };
}

/** Entries in id order: the order two due in the same minute run in (section 7 ‡). */
export function byId(entries: Iterable<Entry>): readonly Entry[] {
  return [...entries].toSorted((a, b) => a.row.id - b.row.id);
}

export function dateDay(date: LocalDate): number {
  return daysFromCivil(date);
}

export function scheduleIds(entries: Iterable<Entry>): readonly ScheduleId[] {
  return byId(entries).map((entry) => entry.row.id);
}
