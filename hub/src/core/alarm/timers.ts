/**
 * The alarm module's timers as its countdowns and alarm imply them (hub-design.md section 2,
 * "Timers"; section 8): one `countdownEnd` per running countdown, at its deadline, and one
 * `alarmEnd` when every siren's time has passed (D67).
 */
import { type Mono, mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import type { AlarmRun, AlarmSlice } from "./state.ts";

/**
 * When the alarm ends by itself: when the last of its sirens' times passes, or, with no siren to
 * sound, its latest trigger's base plus the automatic stop (section 8, "Ending by itself").
 */
export function alarmEndsAt(run: AlarmRun): Mono {
  const untils = [...run.sirens.values()].map((siren) => siren.until);
  return untils.length === 0 ? run.quietEnd : mono(Math.max(...untils));
}

/** The slice with its timers recomputed from its countdowns and alarm. */
export function withTimers(slice: AlarmSlice): AlarmSlice {
  const timers: TimerOf<"alarm">[] = [...slice.countdowns].map(([sensor, countdown]) => ({
    at: countdown.deadline,
    key: { module: "alarm", kind: "countdownEnd", sensor },
  }));
  if (slice.alarm !== undefined) {
    timers.push({ at: alarmEndsAt(slice.alarm), key: { module: "alarm", kind: "alarmEnd" } });
  }
  return { ...slice, timers };
}
