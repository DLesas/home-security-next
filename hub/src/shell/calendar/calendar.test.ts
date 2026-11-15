/**
 * The calendar (m2-design.md section 7, "Schedules" and "Daylight saving"; HB31) against real
 * zones and their real change-over dates, from the runtime's time-zone database:
 *
 * - Europe/London: 29 March 2026, 01:00 GMT jumps to 02:00 BST; 25 October 2026, 02:00 BST goes
 *   back to 01:00 GMT.
 * - America/New_York: 8 March 2026, 02:00 to 03:00; 1 November 2026, 02:00 back to 01:00.
 * - Australia/Sydney (southern hemisphere): 5 April 2026, 03:00 back to 02:00; 4 October 2026,
 *   02:00 to 03:00.
 * - Australia/Lord_Howe (a half-hour change): 5 April 2026, 02:00 back to 01:30; 4 October 2026,
 *   02:00 to 02:30.
 * - America/Santiago (changes at midnight): 4 April 2026, 24:00 back to 23:00; 6 September 2026,
 *   00:00 to 01:00, so the day starts at 01:00.
 * - Pacific/Apia: 30 December 2011 did not happen (29 December, -10:00, was followed by
 *   31 December, +14:00).
 */
import { describe, expect, test } from "bun:test";
import {
  type CalendarRule,
  type DaySet,
  EVERY_DAY,
  type LocalDate,
  type LocalTime,
} from "../../core/model/calendar.ts";
import { makeCalendar, temporalCalendar } from "./calendar.ts";
import { builtInTemporal } from "./temporal.ts";

const built = makeCalendar();
// A test helper of neverthrow's: the calendar must build here, or every test fails at once.
const calendar = built._unsafeUnwrap();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A UTC instant, month 1 to 12. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}

function at(hour: number, minute: number): LocalTime {
  return { hour, minute };
}

function daily(time: LocalTime): CalendarRule {
  return { at: time, days: EVERY_DAY };
}

function on(date: LocalDate, time: LocalTime): CalendarRule {
  return { at: time, days: { date } };
}

/** Monday bit 0 … Sunday bit 6. */
const MON = 1;
const WED = 1 << 2;
const FRI = 1 << 4;
const SAT = 1 << 5;
const SUN = 1 << 6;

function days(bits: number): DaySet {
  return bits as DaySet;
}

/** Every instant the rule gives from `fromMs` up to `untilMs`, by calling `next` from just after each. */
function occurrences(rule: CalendarRule, zone: string, fromMs: number, untilMs: number): number[] {
  const found: number[] = [];
  let next = calendar.next(rule, zone, fromMs);
  while (next !== undefined && next <= untilMs) {
    found.push(next);
    next = calendar.next(rule, zone, next + 1);
  }
  return found;
}

function localText(ms: number, zone: string): string {
  const { date, time, offsetMinutes } = calendar.local(ms, zone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.year}-${two(date.month)}-${two(date.day)} ${two(time.hour)}:${two(time.minute)} ${offsetMinutes}`;
}

describe("the calendar's construction", () => {
  test("it is built over the runtime's Temporal", () => {
    expect(builtInTemporal().isOk()).toBe(true);
    expect(built.isOk()).toBe(true);
  });
});

describe("local time in the site's zone", () => {
  test("next gives the local time on the next day it falls, in the zone, not in UTC", () => {
    // 22:00 in London in July is 21:00 UTC; in New York, 02:00 UTC the next day.
    const from = utc(2026, 7, 1, 12);
    expect(calendar.next(daily(at(22, 0)), "Europe/London", from)).toBe(utc(2026, 7, 1, 21));
    expect(calendar.next(daily(at(22, 0)), "America/New_York", from)).toBe(utc(2026, 7, 2, 2));
    expect(calendar.next(daily(at(22, 0)), "Asia/Kolkata", from)).toBe(utc(2026, 7, 1, 16, 30));
  });

  test("local gives the date, time and offset in the zone", () => {
    expect(localText(utc(2026, 7, 1, 12), "Europe/London")).toBe("2026-07-01 13:00 60");
    expect(localText(utc(2026, 1, 15, 12), "Europe/London")).toBe("2026-01-15 12:00 0");
    expect(localText(utc(2026, 7, 1, 12), "America/New_York")).toBe("2026-07-01 08:00 -240");
    expect(localText(utc(2026, 1, 15, 12), "America/New_York")).toBe("2026-01-15 07:00 -300");
    expect(localText(utc(2026, 7, 1, 12), "Asia/Kathmandu")).toBe("2026-07-01 17:45 345");
    expect(localText(utc(2026, 7, 1, 12), "Australia/Lord_Howe")).toBe("2026-07-01 22:30 630");
  });

  test("a zone the database does not know has no next time, and its local time is UTC's", () => {
    expect(calendar.next(daily(at(22, 0)), "Nowhere/Atlantis", utc(2026, 7, 1))).toBeUndefined();
    expect(localText(utc(2026, 7, 1, 12, 5), "Nowhere/Atlantis")).toBe("2026-07-01 12:05 0");
  });

  test("a rule no clock can show has no next time", () => {
    const from = utc(2026, 7, 1);
    expect(calendar.next(daily(at(24, 0)), "Europe/London", from)).toBeUndefined();
    expect(calendar.next(daily(at(12, 60)), "Europe/London", from)).toBeUndefined();
    expect(calendar.next(daily(at(-1, 0)), "Europe/London", from)).toBeUndefined();
    expect(calendar.next(daily(at(1.5, 0)), "Europe/London", from)).toBeUndefined();
    expect(calendar.next({ at: at(9, 0), days: days(0) }, "Europe/London", from)).toBeUndefined();
    expect(
      calendar.next({ at: at(9, 0), days: days(1 << 7) }, "Europe/London", from),
    ).toBeUndefined();
    expect(calendar.next(daily(at(9, 0)), "Europe/London", Number.NaN)).toBeUndefined();
  });
});

describe("the day's boundary", () => {
  test("at or after: an instant exactly at the time is that time; a millisecond later, the next day", () => {
    const tenPm = utc(2026, 7, 1, 21); // 22:00 BST
    expect(calendar.next(daily(at(22, 0)), "Europe/London", tenPm)).toBe(tenPm);
    expect(calendar.next(daily(at(22, 0)), "Europe/London", tenPm + 1)).toBe(tenPm + DAY);
  });

  test("midnight belongs to the day it starts; 23:59 to the day it ends", () => {
    const from = utc(2026, 6, 30, 22, 59); // 23:59 BST on 30 June
    expect(localText(from, "Europe/London")).toBe("2026-06-30 23:59 60");
    expect(calendar.next(daily(at(23, 59)), "Europe/London", from)).toBe(from);
    const midnight = calendar.next(daily(at(0, 0)), "Europe/London", from);
    expect(midnight).toBe(utc(2026, 6, 30, 23));
    expect(localText(midnight ?? 0, "Europe/London")).toBe("2026-07-01 00:00 60");
    expect(localText((midnight ?? 0) - 1, "Europe/London")).toBe("2026-06-30 23:59 60");
  });

  test("the year's boundary", () => {
    const from = utc(2026, 12, 31, 23, 30); // London is on UTC in winter
    expect(calendar.next(daily(at(0, 0)), "Europe/London", from)).toBe(utc(2027, 1, 1));
    expect(localText(utc(2027, 1, 1), "Europe/London")).toBe("2027-01-01 00:00 0");
  });

  test("an hour after midnight UTC is still yesterday in New York", () => {
    expect(localText(utc(2026, 7, 2, 1), "America/New_York")).toBe("2026-07-01 21:00 -240");
    expect(calendar.next(daily(at(23, 0)), "America/New_York", utc(2026, 7, 2, 1))).toBe(
      utc(2026, 7, 2, 3),
    );
  });
});

describe("weekdays", () => {
  test("Monday is bit 0 and Sunday bit 6, in the zone's week", () => {
    // 1 July 2026 is a Wednesday.
    const from = utc(2026, 7, 1, 12);
    expect(calendar.next({ at: at(9, 0), days: days(FRI) }, "Europe/London", from)).toBe(
      utc(2026, 7, 3, 8),
    );
    expect(calendar.next({ at: at(9, 0), days: days(MON) }, "Europe/London", from)).toBe(
      utc(2026, 7, 6, 8),
    );
    expect(calendar.next({ at: at(9, 0), days: days(SUN) }, "Europe/London", from)).toBe(
      utc(2026, 7, 5, 8),
    );
    expect(calendar.next({ at: at(9, 0), days: days(WED) }, "Europe/London", from)).toBe(
      utc(2026, 7, 8, 8),
    );
    expect(calendar.next({ at: at(13, 30), days: days(WED) }, "Europe/London", from)).toBe(
      utc(2026, 7, 1, 12, 30),
    );
  });

  test("the weekday is the zone's: Saturday 23:00 in New York is Sunday in UTC", () => {
    // Saturday 4 July 2026, 23:00 EDT = Sunday 03:00 UTC.
    const from = utc(2026, 7, 4, 12);
    expect(calendar.next({ at: at(23, 0), days: days(SAT) }, "America/New_York", from)).toBe(
      utc(2026, 7, 5, 3),
    );
    expect(calendar.next({ at: at(23, 0), days: days(SUN) }, "America/New_York", from)).toBe(
      utc(2026, 7, 6, 3),
    );
  });

  test("Monday and Friday, every week for a year: 104 or 105 runs, never another day", () => {
    const rule = { at: at(7, 30), days: days(MON | FRI) };
    const found = occurrences(rule, "Europe/London", utc(2026, 1, 1), utc(2027, 1, 1));
    expect(found.length).toBe(104);
    for (const ms of found) {
      const text = localText(ms, "Europe/London");
      expect(text.slice(11, 16)).toBe("07:30");
      const weekday = new Date(`${text.slice(0, 10)}T12:00:00Z`).getUTCDay();
      expect([1, 5]).toContain(weekday);
    }
  });
});

describe("leap days", () => {
  test("29 February 2028 exists; a one-time entry on it runs then", () => {
    expect(
      calendar.next(
        on({ year: 2028, month: 2, day: 29 }, at(8, 0)),
        "Europe/London",
        utc(2026, 1, 1),
      ),
    ).toBe(utc(2028, 2, 29, 8));
  });

  test("29 February 2027 does not: no next time, not 1 March", () => {
    expect(
      calendar.next(
        on({ year: 2027, month: 2, day: 29 }, at(8, 0)),
        "Europe/London",
        utc(2026, 1, 1),
      ),
    ).toBeUndefined();
    expect(
      calendar.next(
        on({ year: 2026, month: 4, day: 31 }, at(8, 0)),
        "Europe/London",
        utc(2026, 1, 1),
      ),
    ).toBeUndefined();
  });

  test("every day across the end of February: 28, 29, 1 March in 2028; 28, 1 March in 2027", () => {
    const rule = daily(at(23, 30));
    const leap = occurrences(rule, "Europe/London", utc(2028, 2, 28), utc(2028, 3, 2));
    expect(leap.map((ms) => localText(ms, "Europe/London").slice(0, 10))).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
    const common = occurrences(rule, "Europe/London", utc(2027, 2, 28), utc(2027, 3, 2));
    expect(common.map((ms) => localText(ms, "Europe/London").slice(0, 10))).toEqual([
      "2027-02-28",
      "2027-03-01",
    ]);
  });

  test("a Tuesday-only entry finds 29 February 2028, a Tuesday", () => {
    expect(
      calendar.next({ at: at(6, 0), days: days(1 << 1) }, "Europe/London", utc(2028, 2, 25)),
    ).toBe(utc(2028, 2, 29, 6));
  });
});

describe("one-time entries", () => {
  test("once on its date; nothing before the date's instant is returned after it", () => {
    const rule = on({ year: 2026, month: 12, day: 24 }, at(18, 0));
    const ms = utc(2026, 12, 24, 18);
    expect(calendar.next(rule, "Europe/London", utc(2026, 1, 1))).toBe(ms);
    expect(calendar.next(rule, "Europe/London", ms)).toBe(ms);
    expect(calendar.next(rule, "Europe/London", ms + 1)).toBeUndefined();
  });
});

describe("a local time the clock jumps over runs at the first minute after the jump", () => {
  test("London, 29 March 2026: 01:30 does not exist; it runs at 02:00 BST, the jump", () => {
    const ms = calendar.next(daily(at(1, 30)), "Europe/London", utc(2026, 3, 28, 12));
    expect(ms).toBe(utc(2026, 3, 29, 1));
    expect(localText(ms ?? 0, "Europe/London")).toBe("2026-03-29 02:00 60");
    // 01:00 does not exist either; 02:00 does, and is the same instant.
    expect(calendar.next(daily(at(1, 0)), "Europe/London", utc(2026, 3, 28, 12))).toBe(ms);
    expect(calendar.next(daily(at(2, 0)), "Europe/London", utc(2026, 3, 28, 12))).toBe(ms);
    // The day before and the day after, the entry is at 01:30 as usual.
    expect(calendar.next(daily(at(1, 30)), "Europe/London", utc(2026, 3, 27, 12))).toBe(
      utc(2026, 3, 28, 1, 30),
    );
    expect(calendar.next(daily(at(1, 30)), "Europe/London", (ms ?? 0) + 1)).toBe(
      utc(2026, 3, 30, 0, 30),
    );
  });

  test("New York, 8 March 2026: 02:30 runs at 03:00 EDT", () => {
    const ms = calendar.next(daily(at(2, 30)), "America/New_York", utc(2026, 3, 7, 12));
    expect(localText(ms ?? 0, "America/New_York")).toBe("2026-03-08 03:00 -240");
  });

  test("Sydney, 4 October 2026: 02:15 runs at 03:00 AEDT", () => {
    const ms = calendar.next(daily(at(2, 15)), "Australia/Sydney", utc(2026, 10, 3));
    expect(localText(ms ?? 0, "Australia/Sydney")).toBe("2026-10-04 03:00 660");
  });

  test("Lord Howe, 4 October 2026, a half-hour jump: 02:10 runs at 02:30", () => {
    const ms = calendar.next(daily(at(2, 10)), "Australia/Lord_Howe", utc(2026, 10, 3));
    expect(localText(ms ?? 0, "Australia/Lord_Howe")).toBe("2026-10-04 02:30 660");
  });

  test("Santiago, 6 September 2026, the day starts at 01:00: midnight and 00:30 run at 01:00 that day", () => {
    const from = utc(2026, 9, 5, 12);
    const midnight = calendar.next(daily(at(0, 0)), "America/Santiago", from);
    expect(localText(midnight ?? 0, "America/Santiago")).toBe("2026-09-06 01:00 -180");
    expect(calendar.next(daily(at(0, 30)), "America/Santiago", from)).toBe(midnight);
  });

  test("Apia skipped 30 December 2011: a skipped date gets no run (and so no miss)", () => {
    const found = occurrences(
      daily(at(10, 0)),
      "Pacific/Apia",
      utc(2011, 12, 28),
      utc(2012, 1, 1, 12), // 2 January, 02:00 in Apia
    );
    expect(found.map((ms) => localText(ms, "Pacific/Apia"))).toEqual([
      "2011-12-28 10:00 -600",
      "2011-12-29 10:00 -600",
      "2011-12-31 10:00 840",
      "2012-01-01 10:00 840",
    ]);
    expect(
      calendar.next(
        on({ year: 2011, month: 12, day: 30 }, at(10, 0)),
        "Pacific/Apia",
        utc(2011, 12, 1),
      ),
    ).toBeUndefined();
  });
});

describe("a local time that happens twice runs once, at the first", () => {
  test("London, 25 October 2026: 01:30 BST runs; 01:30 GMT an hour later does not", () => {
    const first = calendar.next(daily(at(1, 30)), "Europe/London", utc(2026, 10, 24, 12));
    expect(first).toBe(utc(2026, 10, 25, 0, 30));
    expect(localText(first ?? 0, "Europe/London")).toBe("2026-10-25 01:30 60");
    expect(localText((first ?? 0) + HOUR, "Europe/London")).toBe("2026-10-25 01:30 0");
    // From just after the first, the next is the next day's, not the second 01:30.
    expect(calendar.next(daily(at(1, 30)), "Europe/London", (first ?? 0) + 1)).toBe(
      utc(2026, 10, 26, 1, 30),
    );
    // Even from inside the second 01:00 hour.
    expect(calendar.next(daily(at(1, 30)), "Europe/London", utc(2026, 10, 25, 1, 10))).toBe(
      utc(2026, 10, 26, 1, 30),
    );
  });

  test("New York, 1 November 2026: 01:30 EDT, once", () => {
    const first = calendar.next(daily(at(1, 30)), "America/New_York", utc(2026, 10, 31, 12));
    expect(localText(first ?? 0, "America/New_York")).toBe("2026-11-01 01:30 -240");
    expect(calendar.next(daily(at(1, 30)), "America/New_York", (first ?? 0) + 1)).toBe(
      utc(2026, 11, 2, 6, 30),
    );
  });

  test("Lord Howe, 5 April 2026: 01:45 at +11:00, once", () => {
    const first = calendar.next(daily(at(1, 45)), "Australia/Lord_Howe", utc(2026, 4, 4));
    expect(localText(first ?? 0, "Australia/Lord_Howe")).toBe("2026-04-05 01:45 660");
    const second = (first ?? 0) + 30 * MINUTE;
    expect(localText(second, "Australia/Lord_Howe")).toBe("2026-04-05 01:45 630");
    expect(calendar.next(daily(at(1, 45)), "Australia/Lord_Howe", (first ?? 0) + 1)).toBe(
      (first ?? 0) + DAY + 30 * MINUTE,
    );
  });

  test("Santiago, 4 April 2026, the hour before midnight twice: 23:30 at -03:00, once", () => {
    const first = calendar.next(daily(at(23, 30)), "America/Santiago", utc(2026, 4, 4, 12));
    expect(localText(first ?? 0, "America/Santiago")).toBe("2026-04-04 23:30 -180");
    // From inside the second 23:00 hour (-04:00), the next is 5 April's.
    const inSecond = utc(2026, 4, 5, 3, 10);
    expect(localText(inSecond, "America/Santiago")).toBe("2026-04-04 23:10 -240");
    expect(
      localText(
        calendar.next(daily(at(23, 30)), "America/Santiago", inSecond) ?? 0,
        "America/Santiago",
      ),
    ).toBe("2026-04-05 23:30 -240");
  });
});

describe("a year of entries across daylight saving (m2-design.md section 10)", () => {
  for (const [zone, time] of [
    ["Europe/London", at(1, 30)],
    ["Europe/London", at(22, 0)],
    ["America/New_York", at(2, 30)],
    ["America/New_York", at(1, 30)],
    ["Australia/Sydney", at(2, 30)],
  ] as const) {
    test(`${zone}, every day at ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}: once on each of 365 local dates`, () => {
      const found = occurrences(daily(time), zone, utc(2026, 1, 1, 12), utc(2027, 1, 1, 12));
      expect(found.length).toBe(365);
      const dates = found.map((ms) => localText(ms, zone).slice(0, 10));
      expect(new Set(dates).size).toBe(365);
      for (let i = 1; i < found.length; i++) {
        // 23, 24 or 25 hours apart, or less around a jump the time falls into.
        const gap = (found[i] ?? 0) - (found[i - 1] ?? 0);
        expect(gap).toBeGreaterThan(22 * HOUR);
        expect(gap).toBeLessThanOrEqual(25 * HOUR);
      }
      const times = found.map((ms) => localText(ms, zone).slice(11, 16));
      const wanted = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
      // Every run at its time, except where the clock jumped over it.
      expect(times.filter((t) => t !== wanted).length).toBeLessThanOrEqual(1);
    });
  }
});

describe("over another Temporal", () => {
  test("temporalCalendar takes the API as a parameter, so a polyfill can replace the built-in", () => {
    const other = temporalCalendar(builtInTemporal()._unsafeUnwrap());
    expect(other.next(daily(at(22, 0)), "Europe/London", utc(2026, 7, 1))).toBe(
      calendar.next(daily(at(22, 0)), "Europe/London", utc(2026, 7, 1)),
    );
  });
});
