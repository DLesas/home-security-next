/**
 * Calendar arithmetic as a dependency (m2-design.md section 2, "New events and effects"; section
 * 7, "Schedules"): a pure function set over a fixed time-zone database, passed in `CoreDeps` as
 * `cipher` is. The core may not import the Temporal polyfill (HD 1's layer rules); the shell's
 * implementation is owner A5's (`shell/calendar/`).
 */

/** A local time of day. */
export interface LocalTime {
  /** 0 to 23. */
  readonly hour: number;
  /** 0 to 59. */
  readonly minute: number;
}

/** A local calendar date. */
export interface LocalDate {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  /** 1 to 31. */
  readonly day: number;
}

/** Weekdays as `schedules.days` holds them: a bit per weekday, Monday bit 0, Sunday bit 6. */
export type DaySet = number & { readonly __brand: "DaySet" };

export const EVERY_DAY = 0b111_1111 as DaySet;

/** A schedule entry's rule: a local time on the days a `DaySet` allows, or once on a date. */
export interface CalendarRule {
  readonly at: LocalTime;
  readonly days: DaySet | { readonly date: LocalDate };
}

export interface Calendar {
  /**
   * The first instant at or after `fromMs` (wall, UTC) when the local time in `zone` is `at` on a
   * day the rule allows, or undefined when there is none (a one-time date passed). A local time the
   * clock jumps over runs at the first minute after the jump ‡; one that happens twice runs at the
   * first ‡ (section 7, "Daylight saving").
   */
  next(rule: CalendarRule, zone: string, fromMs: number): number | undefined;
  /** The local date and time of a wall instant, for records and the app. */
  local(
    ms: number,
    zone: string,
  ): { readonly date: LocalDate; readonly time: LocalTime; readonly offsetMinutes: number };
}
