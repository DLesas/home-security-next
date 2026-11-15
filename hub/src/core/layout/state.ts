/**
 * The layout module's slice (m2-design.md section 2, module 7; section 4; section 7, "Modes,
 * groups and arming"): groups and their members, the sirens of each group, modes and their
 * groups, and the current mode with whether arming has changed since the last switch
 * (`mode_state`, this module's single row). Armed state stays the alarm's, per sensor (D74):
 * modes and groups only choose sensors. Configuration, read whole at start and written now.
 */
import type { DeviceId, GroupId, ModeId } from "../model/ids.ts";
import { AWAY_MODE, DISARMED_MODE } from "../model/ids.ts";
import { ModeFixed } from "../model/rows.ts";
import type { TimerOf } from "../model/timers.ts";

/** A group (section 7): a set of sensors and a choice of sirens. */
export interface Group {
  readonly id: GroupId;
  readonly name: string;
  /** Every siren paired at the time of the alarm, the default (AL2a); otherwise `sirens` only. */
  readonly allSirens: boolean;
  readonly sensors: readonly DeviceId[];
  /** The listed sirens, used when `allSirens` is false (`group_sirens`). */
  readonly sirens: readonly DeviceId[];
  readonly revision: number;
}

/** A mode (section 7): a set of groups, or one of the two fixed modes (D90). */
export interface Mode {
  readonly id: ModeId;
  readonly name: string;
  readonly fixed: ModeFixed;
  /** Its groups; the fixed modes hold none, Away arming every sensor and Disarmed none. */
  readonly groups: readonly GroupId[];
  readonly revision: number;
}

export interface LayoutSlice {
  readonly timers: readonly TimerOf<"layout">[];
  readonly groups: ReadonlyMap<GroupId, Group>;
  readonly modes: ReadonlyMap<ModeId, Mode>;
  /** `mode_state.current_mode_id`: null when arming matches no mode (the migration's mixed site). */
  readonly current: ModeId | null;
  /** `mode_state.mode_modified`: arming changed since the last switch ("Away, changed"). */
  readonly modified: boolean;
}

/** The two fixed modes as migration 2 makes them (D90). */
export const FIXED_MODES: readonly Mode[] = [
  { id: AWAY_MODE, name: "Away", fixed: ModeFixed.Away, groups: [], revision: 0 },
  { id: DISARMED_MODE, name: "Disarmed", fixed: ModeFixed.Disarmed, groups: [], revision: 0 },
];

/** The slice before the boot event: the fixed modes, no group, no current mode. */
export const EMPTY_LAYOUT_SLICE: LayoutSlice = {
  timers: [],
  groups: new Map(),
  modes: new Map(FIXED_MODES.map((mode) => [mode.id, mode])),
  current: null,
  modified: false,
};
