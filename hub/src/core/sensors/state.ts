/**
 * The sensors module's slice (hub-design.md section 2, module 10): each sensor's settings and
 * settings versions (its `sensor_config` row, which this module alone writes), the hub's sending
 * counter to it, what its newest status said, the SNR samples behind its reply rate, its loss
 * counts and silence (D107), the replies and disarmed notices in flight, and the module's timers.
 */
import type { SendCounter } from "@hsn/protocol";
import { type BootId, bootId, type DeviceId, type SendRef, type Seq } from "../model/ids.ts";
import type { PacketTable } from "../model/audit.ts";
import type { RadioPurpose } from "../model/messages.ts";
import type { SensorConfigRow } from "../model/rows.ts";
import { type Mono, mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/**
 * What the sensor's newest status packet said that a reply to its log entries goes by: the
 * version it holds and flag bit 7 (section 8, "Which rate a packet goes at").
 */
export interface StatusSeen {
  readonly version: number;
  readonly listeningAtSendRate: boolean;
}

/** One SNR sample of an accepted packet, quarter dB, with the gateway that heard it (section 8). */
export interface SnrSample {
  readonly gateway: DeviceId;
  readonly snrQuarterDb: number;
}

/** One day's counts for D107, as `loss_daily` keeps them. */
export interface LossDay {
  readonly received: number;
  readonly expected: number;
}

export interface SensorEntry {
  readonly device: DeviceId;
  readonly address: number;
  readonly name: string;
  /** Its settings, version, history, arming and move columns: the row written now (section 5). */
  readonly config: SensorConfigRow;
  /** The hub's counter to this sensor's key (section 4). */
  readonly counter: SendCounter;
  /**
   * After a site move's switch, the version that announced it, until the sensor follows: a
   * packet still on the old settings is answered with it (section 8, "Follow").
   */
  readonly announcing: SensorConfigRow | undefined;
  readonly status: StatusSeen | undefined;
  /** The newest accepted counter, for D107's expected count. */
  readonly lastCounter: number;
  readonly snr: readonly SnrSample[];
  /** The reply rate may go faster again from here (6 hours ‡ after a faster change or a bit 7). */
  readonly fasterFrom: Mono | undefined;
  /** The newest accepted packet, or the hub's start, whichever is later (D107). */
  readonly heardAt: Mono;
  /** The rate the newest accepted packet arrived at, for the real interval (§7). */
  readonly heardRate: number | undefined;
  /** D107's n, chosen daily. */
  readonly missed: number;
  /** True once the silence decision was made, until it is heard again. */
  readonly silent: boolean;
  /** `loss_daily` counts by day. */
  readonly loss: ReadonlyMap<number, LossDay>;
  /**
   * The counter of the packet whose reply gave the sensor its slot, once that reply was sent:
   * heartbeats after it are slotted (section 8, "Clock correction"); undefined until then.
   */
  readonly slotFrom: number | undefined;
}

/** A packet handed to a gateway and waiting for its outcome, for its `tx` row (section 6). */
export interface InFlight {
  readonly device: DeviceId;
  readonly purpose: RadioPurpose;
  readonly table: PacketTable;
  readonly type: number;
  readonly counter: number;
  readonly body: Uint8Array;
  readonly rate: number;
  readonly power: number;
  /** The counter of the packet a reply with a next heartbeat answered, when it gives a slot. */
  readonly slotFor: number | undefined;
  /** The record of the packet it answers, for the decisions about it. */
  readonly cause: Seq | undefined;
}

/** A disarmed notice still to be repeated (D24): the same bytes, sealed once (section 4). */
export interface Notice {
  readonly packet: Uint8Array;
  readonly counter: number;
  readonly binding: number;
  readonly gateway: DeviceId | undefined;
  readonly rate: number;
  readonly copiesLeft: number;
}

export interface SensorsSlice {
  readonly timers: readonly TimerOf<"sensors">[];
  readonly boot: BootId;
  /** When this run started: silence counts from here at the latest (D107). */
  readonly startedAt: Mono;
  readonly sensors: ReadonlyMap<DeviceId, SensorEntry>;
  readonly inFlight: ReadonlyMap<SendRef, InFlight>;
  readonly notices: ReadonlyMap<DeviceId, Notice>;
  /** The next `SendRef` this module hands out. */
  readonly nextRef: number;
}

/** The slice before the boot event. */
export const EMPTY_SENSORS_SLICE: SensorsSlice = {
  timers: [],
  boot: bootId(0),
  startedAt: mono(0),
  sensors: new Map(),
  inFlight: new Map(),
  notices: new Map(),
  nextRef: 1,
};
