/**
 * The schedule table's encodings (m2-design.md section 4, `schedules`; section 7, "Weekdays"),
 * as pure arithmetic: a local time as minutes after midnight, weekdays as a bit each (Monday bit
 * 0), a date as days since 1970-01-01, and their texts in the app's messages ("HH:MM",
 * "YYYY-MM-DD", `mon` … `sun`). No time zone enters here: that is the calendar's.
 */
import { weekday } from "@hsn/protocol/app";
import { type DaySet, EVERY_DAY, type LocalDate, type LocalTime } from "../model/calendar.ts";

const MINUTES_PER_HOUR = 60;

/** The weekdays in `schedules.days`'s bit order, Monday first. */
export const WEEKDAYS = weekday.options;
export type Weekday = (typeof WEEKDAYS)[number];

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's `days_from_civil`). */
export function daysFromCivil(date: LocalDate): number {
  const year = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const mp = date.month > 2 ? date.month - 3 : date.month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + date.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** The date `days` after 1970-01-01 (H. Hinnant's `civil_from_days`). */
export function civilFromDays(days: number): LocalDate {
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

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" as minutes after midnight; undefined for text that is no time. */
export function minutesOfText(text: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(text);
  if (match === null) return undefined;
  return Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]);
}

export function textOfMinutes(minutes: number): string {
  return `${two(Math.floor(minutes / MINUTES_PER_HOUR))}:${two(minutes % MINUTES_PER_HOUR)}`;
}

export function timeOfMinutes(minutes: number): LocalTime {
  return { hour: Math.floor(minutes / MINUTES_PER_HOUR), minute: minutes % MINUTES_PER_HOUR };
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function leap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Whether the date is a real one: 29 February only in a leap year. */
export function realDate(date: LocalDate): boolean {
  if (![date.year, date.month, date.day].every(Number.isInteger)) return false;
  if (date.month < 1 || date.month > 12 || date.day < 1) return false;
  const days = date.month === 2 && leap(date.year) ? 29 : (DAYS_IN_MONTH[date.month - 1] ?? 0);
  return date.day <= days;
}

/** "YYYY-MM-DD" as a date; undefined for text that is no real date. */
export function dateOfText(text: string): LocalDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (match === null) return undefined;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return realDate(date) ? date : undefined;
}

export function textOfDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${two(date.month)}-${two(date.day)}`;
}

/** A weekday list as `schedules.days`'s bits. */
export function bitsOfWeekdays(days: readonly Weekday[]): DaySet {
  return days.reduce((bits, day) => bits | (1 << WEEKDAYS.indexOf(day)), 0) as DaySet;
}

/** `schedules.days`'s bits as the app's days: `"everyDay"` for all seven, else Monday first. */
export function weekdaysOfBits(bits: number): readonly Weekday[] | "everyDay" {
  if ((bits & EVERY_DAY) === EVERY_DAY) return "everyDay";
  return WEEKDAYS.filter((_, i) => (bits & (1 << i)) !== 0);
}
