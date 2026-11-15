/**
 * The health module's slice (m2-design.md section 2): battery percentages and low-battery state
 * per device, tamper state.
 *
 * - The battery percentage is not stored (section 3): the slice keeps the newest reading's cell
 *   voltage, from the packet with the highest counter (HD 8) or, after a restart, from the stored
 *   reading (`device_state.reading`), and the percentage is computed from it when asked.
 * - Low battery and tamper are the `health_state` row, written now when either changes, so a
 *   warning raised once is not raised again after a restart (HB33, section 3).
 * - Silence is kept as the sensors and sirens modules decided it, until the device is heard
 *   again, for the device screens (`deviceHealth.silent`).
 */
import type { DeviceId } from "../model/ids.ts";
import type { TimerOf } from "../model/timers.ts";

/** What the newest reading said of a device's cell. */
export interface CellReading {
  readonly millivolts: number;
  /**
   * The device runs on mains, not its cell: a siren on its supply (D109). Its readings neither
   * raise nor clear low battery while it does. Always false for a sensor, whose own cell runs it
   * (D109; HB33 names no exception for one charging over USB).
   */
  readonly onMains: boolean;
}

export interface DeviceHealth {
  /** Undefined until a reading with a cell voltage is known. */
  readonly cell: CellReading | undefined;
  /** `health_state.battery_low`: raised once on the way down (HB33). */
  readonly batteryLow: boolean;
  /** `health_state.tamper_open`: the cover is open (D9). */
  readonly tamperOpen: boolean;
  /** A `sensor_silent` or `siren_silent` decision, until a packet is accepted from the device. */
  readonly silent: boolean;
  /** A sensor losing more than a fifth of its packets over 7 days (D107), as last judged. */
  readonly poorLink: boolean;
  /** When the last opening told as `tamper_opened` happened, wall ms; memory only. */
  readonly openedAtMs: number | undefined;
  /** The cover a heartbeat showed against `tamperOpen` and was warned about (D114). */
  readonly coverShown: boolean | undefined;
}

export interface HealthSlice {
  readonly timers: readonly TimerOf<"health">[];
  /** Every device the module has heard of or restored, by id. */
  readonly devices: ReadonlyMap<DeviceId, DeviceHealth>;
}

/** A device the module knows nothing of yet. */
export const NO_HEALTH: DeviceHealth = {
  cell: undefined,
  batteryLow: false,
  tamperOpen: false,
  silent: false,
  poorLink: false,
  openedAtMs: undefined,
  coverShown: undefined,
};

/** The slice before the boot event. */
export const EMPTY_HEALTH_SLICE: HealthSlice = { timers: [], devices: new Map() };
