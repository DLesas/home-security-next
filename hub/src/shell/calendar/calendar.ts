/**
 * The `Calendar` dependency (m2-design.md section 2; section 7, "Schedules" and "Daylight
 * saving"; HB31) over the Temporal API and its time-zone database: pure functions of their
 * arguments, as `deps.cipher` is.
 *
 * - `next(rule, zone, fromMs)`: for each local date, the one instant the rule names on it, as
 *   section 7 settles it: the local time; when the clock jumps over it, the first minute after
 *   the jump, on that same date (`skippedTime: "firstMinuteAfter"`); when the clock goes back
 *   over it, the first of the two (`repeatedTime: "first"`). The earliest such instant at or
 *   after `fromMs`.
 * - A local date the zone skips altogether (Pacific/Apia's 30 December 2011), or a jump that
 *   lands on the next date, has no such instant: that date gets no run, and no miss either, since
 *   nothing fell due on it.
 * - `local(ms, zone)`: the local date, time and offset of an instant.
 *
 * Temporal throws `RangeError` on an unknown zone or an instant out of its range. Every call is
 * made through neverthrow's `Result.fromThrowable` (as `core/util/protocol-safe.ts` wraps the
 * protocol's throwing functions, HD 10), so nothing escapes into the core's step: an unknown zone
 * has no next time, and its local time is UTC's. This is where Temporal is wrapped (section 11,
 * "Step 1's questions, settled"; HD 10's table gains the row).
 */
import { err, ok, Result } from "neverthrow";
import type {
  Calendar,
  CalendarRule,
  DaySet,
  LocalDate,
  LocalTime,
} from "../../core/model/calendar.ts";
import type { HubError } from "../../core/model/errors.ts";
import {
  builtInTemporal,
  type TemporalApi,
  type TemporalPlainDate,
  type TemporalZonedDateTime,
} from "./temporal.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const NANOSECONDS_PER_MINUTE = 60_000_000_000;
/** Temporal's range of instants: 10⁸ days either side of 1970 (ECMA-262's time values). */
const LIMIT_MS = 8.64e15;
/**
 * How many local dates around `fromMs`'s are looked at. A weekly rule needs 8; a skipped date
 * (Pacific/Apia, 2011) and the date before `fromMs`'s, which a clock going back over midnight can
 * still hold, need a few more.
 */
const DATES_BEFORE = 1;
const DATES_AFTER = 15;
const ALL_DAYS = 0b111_1111;

type Local = ReturnType<Calendar["local"]>;

function validTime(at: LocalTime): boolean {
  return (
    Number.isInteger(at.hour) &&
    Number.isInteger(at.minute) &&
    at.hour >= 0 &&
    at.hour <= 23 &&
    at.minute >= 0 &&
    at.minute <= 59
  );
}

function validDaySet(days: DaySet): boolean {
  return Number.isInteger(days) && days > 0 && days <= ALL_DAYS;
}

function sameDate(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function dateOf(value: TemporalPlainDate | TemporalZonedDateTime): LocalDate {
  return { year: value.year, month: value.month, day: value.day };
}

/** The date as given, or undefined when it is no real date (30 February). */
function realDate(temporal: TemporalApi, date: LocalDate): TemporalPlainDate | undefined {
  if (![date.year, date.month, date.day].every(Number.isInteger)) return undefined;
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return undefined;
  const plain = temporal.PlainDate.from(date, { overflow: "constrain" });
  return sameDate(dateOf(plain), date) ? plain : undefined;
}

/**
 * The one instant the rule's local time names on `date` in `zone` (the rules above), or undefined
 * when that date has none.
 */
function instantOn(
  temporal: TemporalApi,
  date: LocalDate,
  at: LocalTime,
  zone: string,
): number | undefined {
  const earlier = temporal.ZonedDateTime.from(
    { ...date, hour: at.hour, minute: at.minute, timeZone: zone },
    { disambiguation: "earlier", overflow: "reject" },
  );
  if (sameDate(dateOf(earlier), date) && earlier.hour === at.hour && earlier.minute === at.minute) {
    // The local time exists; when it happens twice, "earlier" is the first.
    return earlier.epochMilliseconds;
  }
  // The clock jumps over it: "earlier" read the time with the offset before the jump, an
  // instant before it, so the next transition is the jump itself.
  const jump = earlier.getTimeZoneTransition("next");
  if (jump === null || !sameDate(dateOf(jump), date)) return undefined;
  return jump.epochMilliseconds;
}

function allowed(days: DaySet, date: TemporalPlainDate): boolean {
  return (days & (1 << (date.dayOfWeek - 1))) !== 0;
}

function nextInstant(
  temporal: TemporalApi,
  rule: CalendarRule,
  zone: string,
  fromMs: number,
): number | undefined {
  if (!validTime(rule.at) || !Number.isFinite(fromMs)) return undefined;
  if (fromMs > LIMIT_MS - 2 * DATES_AFTER * DAY_MS) return undefined;
  const from = Math.max(Math.floor(fromMs), -LIMIT_MS + 2 * DAY_MS);
  const today = temporal.Instant.fromEpochMilliseconds(from).toZonedDateTimeISO(zone).toPlainDate();
  const { days } = rule;
  if (typeof days !== "number") {
    const date = realDate(temporal, days.date);
    if (date === undefined) return undefined;
    const ms = instantOn(temporal, dateOf(date), rule.at, zone);
    return ms !== undefined && ms >= fromMs ? ms : undefined;
  }
  if (!validDaySet(days)) return undefined;
  let earliest: number | undefined;
  for (let offset = -DATES_BEFORE; offset <= DATES_AFTER; offset++) {
    const date = today.add({ days: offset });
    if (!allowed(days, date)) continue;
    const ms = instantOn(temporal, dateOf(date), rule.at, zone);
    if (ms !== undefined && ms >= fromMs && (earliest === undefined || ms < earliest)) {
      earliest = ms;
    }
  }
  return earliest;
}

function localOf(temporal: TemporalApi, ms: number, zone: string): Local {
  const clamped = Math.min(Math.max(Math.floor(ms), -LIMIT_MS), LIMIT_MS);
  const zoned = temporal.Instant.fromEpochMilliseconds(clamped).toZonedDateTimeISO(zone);
  return {
    date: dateOf(zoned),
    time: { hour: zoned.hour, minute: zoned.minute },
    offsetMinutes: zoned.offsetNanoseconds / NANOSECONDS_PER_MINUTE,
  };
}

/** Days since 1970-01-01 to a proleptic Gregorian date (H. Hinnant's `civil_from_days`). */
function civilFromDays(days: number): LocalDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** UTC by arithmetic: what `local` answers when the zone is unknown and Temporal fails too. */
function utcOf(ms: number): Local {
  const whole = Number.isFinite(ms) ? Math.floor(ms / MINUTE_MS) * MINUTE_MS : 0;
  const days = Math.floor(whole / DAY_MS);
  const inDay = whole - days * DAY_MS;
  return {
    date: civilFromDays(days),
    time: {
      hour: Math.floor(inDay / 3_600_000),
      minute: Math.floor((inDay % 3_600_000) / MINUTE_MS),
    },
    offsetMinutes: 0,
  };
}

/** The calendar over a given Temporal API: the runtime's own, or a polyfill's. */
export function temporalCalendar(temporal: TemporalApi): Calendar {
  const safeNext = Result.fromThrowable(
    (rule: CalendarRule, zone: string, fromMs: number) => nextInstant(temporal, rule, zone, fromMs),
    () => undefined,
  );
  const safeLocal = Result.fromThrowable(
    (ms: number, zone: string) => localOf(temporal, ms, zone),
    () => undefined,
  );
  return {
    next: (rule, zone, fromMs) => safeNext(rule, zone, fromMs).unwrapOr(undefined),
    local: (ms, zone) =>
      safeLocal(ms, zone)
        .orElse(() => safeLocal(ms, "UTC"))
        .match(
          (local) => local,
          () => utcOf(ms),
        ),
  };
}

/** The calendar over the runtime's built-in Temporal, for `main.ts` and the lockstep hub. */
export function makeCalendar(): Result<Calendar, HubError> {
  const temporal = builtInTemporal();
  return temporal.isOk() ? ok(temporalCalendar(temporal.value)) : err(temporal.error);
}
