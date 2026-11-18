/**
 * Days for the relay's limits (docs/m4-design.md section 3, D142): "a day" is the UTC day, as the
 * traffic row has it ("new streams refused until midnight UTC"); minutes, hours and seconds are
 * sliding windows. Pure.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const TIME = { SECOND, MINUTE, HOUR, DAY: 24 * HOUR } as const;

/** The UTC day a time falls in, counted from 1970-01-01. */
export function utcDay(ms: number): number {
  return Math.floor(ms / TIME.DAY);
}

/** How long from `ms` until the next midnight UTC; a full day at midnight itself. */
export function untilNextUtcDay(ms: number): number {
  return (utcDay(ms) + 1) * TIME.DAY - ms;
}
