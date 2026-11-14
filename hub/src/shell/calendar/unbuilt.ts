/**
 * Step 0's calendar (m2-design.md section 11): the `Calendar` dependency with no time-zone
 * database behind it, so the core and every test can be built before owner A5 writes the real
 * one over the Temporal polyfill in this folder. `next` finds nothing, so no schedule entry is
 * ever due; `local` reads the instant in UTC whatever the zone. Nothing in step 0 calls either.
 */
import type { Calendar } from "../../core/model/calendar.ts";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const UNBUILT_CALENDAR: Calendar = {
  next: () => undefined,
  local: (ms) => {
    const date = new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS);
    const inDay = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
    return {
      date: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
      time: {
        hour: Math.floor(inDay / 3_600_000),
        minute: Math.floor((inDay % 3_600_000) / MINUTE_MS),
      },
      offsetMinutes: 0,
    };
  },
};
