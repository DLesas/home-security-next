/**
 * The site module's slice (hub-design.md section 2, module 9; section 8, "Changing the site's
 * channel or rate"; D115): the site's settings (its `site` row, which this module alone writes),
 * the move in progress with its stage and target, each sensor's confirmation and follow, the
 * sirens that followed, the sensors a forced move left behind, and the module's timers.
 */
import { type BootId, bootId, type DeviceId } from "../model/ids.ts";
import type { SiteRow } from "../model/rows.ts";
import { type Mono, mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** One sensor's part in the latest move (section 8; `sensor_config.move_confirmed`, `move_followed`). */
export interface SensorPart {
  /** The move id it confirmed, 0 for none. */
  readonly confirmed: number;
  /** The move id it followed, 0 for none. */
  readonly followed: number;
  /** From when its confirmation is waited for, for `move_stalled` (section 8). */
  readonly waitingSince: Mono;
}

/** The settings before a switch, kept for the silence grace's old interval (section 8). */
export interface Before {
  readonly channel: number | null;
  readonly rate: number;
}

export interface SiteSlice {
  readonly timers: readonly TimerOf<"site">[];
  readonly boot: BootId;
  readonly startedAt: Mono;
  /** The `site` row: settings, and the move's columns. */
  readonly row: SiteRow;
  readonly sensors: ReadonlyMap<DeviceId, SensorPart>;
  /** Sirens by id, true once followed in the current move. */
  readonly sirens: ReadonlyMap<DeviceId, boolean>;
  /** Sensors a forced move left behind: state 5, to be paired again (section 6). */
  readonly leftBehind: ReadonlySet<DeviceId>;
  /** When the switch was made, on this boot's clock; the silence grace counts from it. */
  readonly switchedAt: Mono | undefined;
  /** The settings before the switch, while known (this run). */
  readonly before: Before | undefined;
  /**
   * After a restart in the switched stage: how long before the last commit the switch was, so
   * the switch time can be re-expressed once the downtime is known (section 8, D113).
   */
  readonly switchedBeforeStopMs: number | undefined;
  /** True once `move_switch_waiting` was recorded for this move: a countdown or alarm runs. */
  readonly switchWaiting: boolean;
}

/** The slice before the boot event; its row is replaced at boot. */
export const EMPTY_SITE_SLICE: SiteSlice = {
  timers: [],
  boot: bootId(0),
  startedAt: mono(0),
  row: {
    channel: null,
    rateMask: 0,
    moveId: 0,
    moveStage: 0,
    moveChannel: null,
    moveRate: null,
    moveActor: null,
    moveRequestedMs: null,
    moveForced: false,
    moveSwitchedBoot: null,
    moveSwitchedMono: null,
    wifiName: new Uint8Array(),
    wifiPassword: new Uint8Array(),
    countdownDefaultS: 0,
    autoStopS: 0,
    replyPowerDbm: 0,
    sirenPowerDbm: 0,
    retentionRoutineDays: 0,
    retentionEventDays: 0,
  },
  sensors: new Map(),
  sirens: new Map(),
  leftBehind: new Set(),
  switchedAt: undefined,
  before: undefined,
  switchedBeforeStopMs: undefined,
  switchWaiting: false,
};
