/**
 * The alarm module's slice (hub-design.md section 2, module 8; section 8, "Arming and the
 * countdown"): the arming state of every sensor, the countdowns, the alarm with its triggers and
 * what each siren should do, and the siren tests. Its timers (`countdownEnd`, `alarmEnd`) are
 * data in `timers` (section 2, "Timers"), kept equal to what the countdowns and the alarm imply by
 * `withTimers` after every message the handler changes the slice for.
 */
import { type BootId, bootId, type DeviceId, type Seq } from "../model/ids.ts";
import type { AlarmTriggerKind, ArmState } from "../model/rows.ts";
import { type Mono, mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** What the newest door changed report said (section 8): the door rules act on nothing else. */
export interface DoorReport {
  readonly open: boolean;
  /** The door change count it carried (§6), for `door_changes_missed`. */
  readonly changeCount: number;
}

/** One sensor's arming (section 8, the four states; D50, D67, D74). */
export interface SensorArming {
  readonly arm: ArmState;
  /** When it was armed (`sensor_config.armed_boot`, `armed_mono`); null while disarmed. */
  readonly armedBoot: BootId | null;
  readonly armedMono: Mono | null;
  /** Its entry countdown in seconds (D86), 0 sounding at once. */
  readonly countdownS: number;
  /** The newest door changed report, or undefined before the first. */
  readonly door: DoorReport | undefined;
  /** Whether the newest status packet of any kind showed the door open: arming's check (D50). */
  readonly doorNow: boolean | undefined;
  /** A heartbeat's door state contradicted `door` and the warning is recorded (section 8). */
  readonly doorWarned: boolean;
  /** The change count a heartbeat showed ahead of `door` that has been warned about. */
  readonly changesWarned: number | undefined;
}

/** A running entry countdown (AL3, AL4, D86, D106). */
export interface Countdown {
  /** When the door opened: the report's end less its age (D106). */
  readonly openedAt: Mono;
  readonly deadline: Mono;
  /** The newest accepted report of the opening: the disarmed notice's binding (§4). */
  readonly newestCounter: number;
  /** The gateway the reply goes through, and the rate it goes at (section 5, D80). */
  readonly replyGateway: DeviceId | undefined;
  readonly replyRate: number;
  /** The record of the report that started it. */
  readonly cause: Seq;
  /** Restored at boot and not yet judged with a known downtime (D113). */
  readonly restored: boolean;
}

/** One trigger of the alarm (D95). */
export interface Trigger {
  readonly kind: AlarmTriggerKind;
  /** When it joined the alarm. */
  readonly at: Mono;
  readonly restored: boolean;
}

/**
 * Where a siren of a restored alarm stands (section 5, "What the hub does on a start where it
 * cannot know how long it was down"; D80, D113):
 * - `fresh`: sounded in this run, or judged with a known downtime: the ordinary rules apply;
 * - `awaitReport`: restored while the downtime is unknown and not yet heard from: believed if it
 *   reports sounding, never commanded;
 * - `check`: restored, the downtime known (or the siren never confirmed sounding), not yet heard
 *   from: the correction rule sounds it for what is left;
 * - `cutShort`: restored with the downtime unknown, and it reported off or started after a
 *   power-on: not commanded again until the downtime is known.
 */
export type SirenRestore = "fresh" | "awaitReport" | "check" | "cutShort";

/** One siren the alarm sounds, and until when (section 8, "What the siren should do"). */
export interface AlarmSiren {
  readonly until: Mono;
  /** A report showed it sounding for this alarm (`alarm_sirens.commanded`). */
  readonly commanded: boolean;
  readonly restore: SirenRestore;
}

/** The alarm: its triggers and the sirens they sound (D74, D95). */
export interface AlarmRun {
  readonly startedAt: Mono;
  /** The `alarm` decision's record. */
  readonly cause: Seq;
  readonly triggers: ReadonlyMap<DeviceId, Trigger>;
  readonly sirens: ReadonlyMap<DeviceId, AlarmSiren>;
  /** When an alarm with no siren ends by itself: the latest trigger's base plus the automatic stop. */
  readonly quietEnd: Mono;
}

/** The alarm module's slice (section 2, module 8). */
export interface AlarmSlice {
  /** The module's timers, as the countdowns and the alarm imply them. */
  readonly timers: readonly TimerOf<"alarm">[];
  /** This run's boot, from the boot event; 0 before it. */
  readonly boot: BootId;
  /** The monotonic time of the boot event: restored deadlines count from it (D113). */
  readonly bootAt: Mono;
  /** The site's automatic stop and default countdown, seconds (D40). */
  readonly autoStopS: number;
  readonly countdownDefaultS: number;
  readonly sensors: ReadonlyMap<DeviceId, SensorArming>;
  readonly countdowns: ReadonlyMap<DeviceId, Countdown>;
  readonly alarm: AlarmRun | undefined;
  /** Siren tests (D65, SR9): until when each siren should test. */
  readonly tests: ReadonlyMap<DeviceId, Mono>;
  /** True once nothing restored waits for the downtime to be known (D113). */
  readonly downtimeJudged: boolean;
}

/** The slice before the boot event. */
export const EMPTY_ALARM_SLICE: AlarmSlice = {
  timers: [],
  boot: bootId(0),
  bootAt: mono(0),
  autoStopS: 0,
  countdownDefaultS: 0,
  sensors: new Map(),
  countdowns: new Map(),
  alarm: undefined,
  tests: new Map(),
  downtimeJudged: true,
};
