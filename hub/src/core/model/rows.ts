/**
 * One row of each table of hub-design.md section 6, as the core reads it at start
 * (`DurableSnapshot`) and writes it (`StoreOp`, `AuditRecord`). Property names are the columns
 * in camel case; `db/schema.ts` declares the same tables for SQLite, and a test holds the two
 * to the same columns. `null` is SQL's NULL. Times: `*Ms` wall milliseconds, `*Mono`
 * microseconds on the monotonic clock of the boot in the row's `boot` column.
 */
import type { DecisionKind } from "./decisions.ts";
import type { RejectReason } from "./errors.ts";
import type { BootId, DeviceId, Seq } from "./ids.ts";
import type { Mono } from "./time.ts";

/** `devices.state` (section 6). */
export const DeviceState = {
  Provisioning: 0,
  Paired: 1,
  Contacted: 2,
  ResetByOwner: 3,
  Removed: 4,
  /** Left behind by a forced site move: must be paired again (D115, section 8). */
  LeftBehind: 5,
} as const;
export type DeviceState = (typeof DeviceState)[keyof typeof DeviceState];

/** `sensor_config.arm`: the four arming states of section 8, "Arming and the countdown". */
export const ArmState = {
  Disarmed: 0,
  Armed: 1,
  /** Armed, waiting for the door to close: it was open when armed (D50, D114). */
  WaitsForCloseAfterArming: 2,
  /** Armed, waiting for the door to close: after an alarm it set off ended by itself (D67). */
  WaitsForCloseAfterAlarm: 3,
} as const;
export type ArmState = (typeof ArmState)[keyof typeof ArmState];

/** `alarm_triggers.kind` (section 6). */
export const AlarmTriggerKind = { CountdownEnd: 0, ZeroCountdown: 1, LateReport: 2 } as const;
export type AlarmTriggerKind = (typeof AlarmTriggerKind)[keyof typeof AlarmTriggerKind];

/** `path` of the packet tables: how a packet travelled (section 6). */
export const PacketPath = { Lora: 0, Wifi: 1, Usb: 2 } as const;
export type PacketPath = (typeof PacketPath)[keyof typeof PacketPath];

/** `tx_*.outcome` (section 6): codes 0 to 4 are the gateway's transmit result codes (§6). */
export const TxOutcome = {
  Sent: 0,
  TooLate: 1,
  NoAirtime: 2,
  RadioBusy: 3,
  NotValid: 4,
  NoResult: 5,
  HandedToLink: 6,
  HeldBack: 7,
  SendFailed: 8,
} as const;
export type TxOutcome = (typeof TxOutcome)[keyof typeof TxOutcome];

/** How the previous run ended, as the boot record says (section 10, "The top-level handler"). */
export type PreviousExit = "clean" | "crash" | "unknown";

/** Levels of the hub's own events (`hub_events.level`, HB34). */
export type HubEventLevel = "debug" | "info" | "warning" | "critical";

// Configuration and durable state, written now (section 6).

export interface DeviceRow {
  readonly id: DeviceId;
  readonly address: number;
  /** A protocol `Role`: 1 sensor, 2 siren, 3 gateway; 0 for the hub's own row. */
  readonly role: number;
  readonly name: string;
  readonly chipId: Uint8Array;
  /** major × 65,536 + minor × 256 + patch. */
  readonly firmware: number;
  readonly development: boolean;
  readonly state: DeviceState;
  readonly addedMs: number;
  readonly removedMs: number | null;
}

/** Kept apart from `devices` so no query of `devices` reads a key. */
export interface DeviceKeyRow {
  readonly deviceId: DeviceId;
  readonly key: Uint8Array;
}

/** The hub's sending counter's saved resume point for one device key (section 4). */
export interface SendCounterRow {
  readonly deviceId: DeviceId;
  readonly resumePoint: number;
}

/** Single row: the hub's firmware-signing key pair and identity (§9). */
export interface HubKeysRow {
  /** PKCS #8. Read by the shell only; never part of a `DurableSnapshot`. */
  readonly signingPrivate: Uint8Array;
  /** X then Y, 64 bytes. */
  readonly signingPublic: Uint8Array;
  /** The first 8 bytes of SHA-256 of `signingPublic` (§9). */
  readonly identity: Uint8Array;
}

/** `site.move_stage`: a site move's stage (D115, section 6). */
export const MoveStage = { None: 0, Announcing: 1, Switched: 2, Done: 3, Cancelled: 4 } as const;
export type MoveStage = (typeof MoveStage)[keyof typeof MoveStage];
/** A move's stage by name, as messages and the CLI give it. */
export type MoveStageName = "announcing" | "switched" | "done" | "cancelled";

/** In `sensor_config.next_channel` and `next_rate`: that one stays as it is; both: no move (§6). */
export const NEXT_SETTING_STAYS = 0xff;

/** Single row: site settings and the site move (sections 6, 8 and 9; D115), all written now. */
export interface SiteRow {
  /** A protocol `SiteChannel`; null until chosen (section 8, "Site channel and data rate"). */
  readonly channel: number | null;
  readonly rateMask: number;
  /** The latest move's id, 0 before the first. */
  readonly moveId: number;
  readonly moveStage: MoveStage;
  /** The target channel and rate; `NEXT_SETTING_STAYS` for one that stays. */
  readonly moveChannel: number | null;
  readonly moveRate: number | null;
  readonly moveActor: string | null;
  readonly moveRequestedMs: number | null;
  readonly moveForced: boolean;
  /** When the switch was made; the silence grace counts from it (section 8). */
  readonly moveSwitchedBoot: BootId | null;
  readonly moveSwitchedMono: Mono | null;
  readonly wifiName: Uint8Array;
  readonly wifiPassword: Uint8Array;
  readonly countdownDefaultS: number;
  readonly autoStopS: number;
  readonly replyPowerDbm: number;
  readonly sirenPowerDbm: number;
  readonly retentionRoutineDays: number;
  readonly retentionEventDays: number;
}

export interface SensorConfigRow {
  readonly deviceId: DeviceId;
  readonly arm: ArmState;
  readonly armedBoot: BootId | null;
  readonly armedMono: Mono | null;
  readonly countdownS: number;
  readonly heartbeatUnits: number;
  readonly linkCheckEvery: number;
  readonly sendRate: number;
  readonly replyRate: number;
  readonly replyRateFixed: boolean;
  /** Units of 10 ppm, as the reply carries them (§6). */
  readonly correctionUnits: number;
  readonly correctionFixed: boolean;
  /** What its current version announces (D115): `NEXT_SETTING_STAYS` for one that stays. */
  readonly nextChannel: number;
  readonly nextRate: number;
  /** The move id it confirmed, 0 for none. */
  readonly moveConfirmed: number;
  /** The move id it followed, 0 for none. */
  readonly moveFollowed: number;
  readonly version: number;
  /** The last 16 versions, 3 bytes each: version, reply rate, the move it announces or 0. */
  readonly versionHistory: Uint8Array;
}

export interface SirenConfigRow {
  readonly deviceId: DeviceId;
  readonly version: number;
  readonly wifiIntervalS: number;
  readonly loraCheckUnits: number;
  readonly maxSoundS: number;
  readonly sendRate: number;
  readonly commandRate: number;
  /** The site channel its current version carries (§6, Siren settings; D115). */
  readonly siteChannel: number;
  /**
   * Its recent versions with their command rates (section 8, "Which rate a packet goes at").
   * Section 6 gives no layout; the owner sets one, starting with a format byte (section 6).
   */
  readonly versionHistory: Uint8Array;
}

export interface GatewayConfigRow {
  readonly deviceId: DeviceId;
  readonly version: number;
  readonly statusIntervalS: number;
  readonly interferenceDb: number;
  readonly interferenceS: number;
  readonly defaultPowerDbm: number;
  readonly sirenPowerDbm: number;
}

/** A running countdown (D80, HB30): written now before the reply that says it started. */
export interface CountdownRow {
  readonly sensorId: DeviceId;
  readonly boot: BootId;
  readonly openedMono: Mono;
  readonly deadlineMono: Mono;
  /** The newest accepted report of the opening: the disarmed notice's binding (§4). */
  readonly newestCounter: number;
  readonly replyGatewayId: DeviceId | null;
  readonly replyRate: number;
  readonly causeSeq: Seq;
}

/** Single row while an alarm runs (D80, D95). */
export interface AlarmRow {
  readonly boot: BootId;
  readonly startedMono: Mono;
  readonly causeSeq: Seq;
}

export interface AlarmTriggerRow {
  readonly sensorId: DeviceId;
  readonly kind: AlarmTriggerKind;
  readonly boot: BootId;
  readonly atMono: Mono;
}

export interface AlarmSirenRow {
  readonly sirenId: DeviceId;
  readonly boot: BootId;
  readonly untilMono: Mono;
  readonly commanded: boolean;
}

export interface BootRow {
  readonly id: BootId;
  readonly startedMs: number;
  readonly startedTrusted: boolean;
  readonly previousExit: PreviousExit;
  readonly cause: string | null;
  readonly cleanStopMs: number | null;
  readonly trustedAtMono: Mono | null;
  /** The wall clock's step when it became trusted (section 5). */
  readonly clockStepMs: number | null;
}

// Readings and estimates, routine (section 6).

/**
 * A device's latest readings. Device 0's row is the commit mark: `boot`, `lastSeenMono`,
 * `lastSeenMs` and `clockOk` of the commit (section 5).
 */
export interface DeviceStateRow {
  readonly deviceId: DeviceId;
  readonly boot: BootId;
  readonly lastSeenMono: Mono;
  readonly lastSeenMs: number;
  /**
   * Whether `lastSeenMs` was a trusted wall time. SPEC-QUESTION: section 6 lists no column for
   * the commit mark's wall trust, which section 5 says it holds; this column is added for it.
   */
  readonly clockOk: boolean;
  /** `encodeReplayWindow`, 12 bytes. */
  readonly window: Uint8Array | null;
  /** The latest status body, raw. */
  readonly reading: Uint8Array | null;
  readonly rssi: number | null;
  readonly snrQ: number | null;
  readonly bestGatewayId: DeviceId | null;
  /** Gateways: the uptime of their last status (section 5, "How long was the hub down?"). */
  readonly uptimeS: number | null;
  /** A format byte, then the role's estimates. */
  readonly estimates: Uint8Array | null;
}

/** Heartbeats received and expected per device and day, for D107's n. Kept 30 days. */
export interface LossDailyRow {
  readonly deviceId: DeviceId;
  /** Days since 1970 by the wall clock. */
  readonly day: number;
  readonly received: number;
  readonly expected: number;
}

// The audit record (section 6). Each row's `seq` is its row id.

/** A packet received: `rx_routine` or `rx_event` by its type (section 6). */
export interface RxRow {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly deviceId: DeviceId;
  readonly type: number;
  readonly counter: number;
  readonly path: PacketPath;
  readonly gatewayId: DeviceId | null;
  /** The gateway's microsecond clock when the packet finished arriving. */
  readonly gwUs: number | null;
  /**
   * The counter of the gateway's forwarded packet that carried it (D110): with `gatewayId`, every
   * packet a gateway sent the hub is found by gateway and counter. Null when no gateway was.
   */
  readonly gwCounter: number | null;
  readonly rssi: number | null;
  readonly snrQ: number | null;
  readonly rate: number | null;
  /** Decrypted, after the type byte. */
  readonly body: Uint8Array;
}

/** A packet sent to a device, one row per transmission: `tx_routine` or `tx_event`. */
export interface TxRow {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly deviceId: DeviceId;
  readonly type: number;
  readonly counter: number;
  readonly path: PacketPath;
  readonly gatewayId: DeviceId | null;
  /** The transmit request's gateway counter, for packets sent through a gateway. */
  readonly requestCounter: number | null;
  /** The counter of the gateway's transmit result that reported the outcome; null for none. */
  readonly resultCounter: number | null;
  readonly rate: number | null;
  readonly power: number | null;
  readonly outcome: TxOutcome;
  readonly gwSentUs: number | null;
  readonly body: Uint8Array;
}

/** Every decision with the record that caused it (section 8, D110). */
export interface DecisionRow {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly kind: DecisionKind;
  readonly deviceId: DeviceId | null;
  readonly causeSeq: Seq | null;
  readonly value: number | null;
  readonly detail: Uint8Array | null;
}

/** One entry of a log entries packet (§6), repeats included. */
export interface DeviceLogRow {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly deviceId: DeviceId;
  readonly counter: number;
  readonly madeMs: number;
  readonly level: number;
  readonly code: number;
  /** The entry's text bytes as sent (§3: shown with replacement characters when not UTF-8). */
  readonly text: Uint8Array;
  /** The counter of the earlier packet this entry repeats (section 8), or null. */
  readonly repeatOf: number | null;
}

/** The hub's own errors, warnings and notices (HB34). */
export interface HubEventRow {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly level: HubEventLevel;
  /** Where it arose, as `HubError.origin`: "shell/storage/writer", "core/sirens". */
  readonly origin: string;
  readonly code: string;
  readonly message: string;
  readonly detail: string | null;
}

/** Every control command and who sent it (AL8). */
export interface CommandRow {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly actor: string;
  readonly kind: string;
  /** The command's arguments as JSON. */
  readonly args: string;
  readonly outcome: string;
  readonly detail: string | null;
}

/** One row per source and reason per minute (HB15), a full value upserted by its key. */
export interface RejectRow {
  /** Minutes since 1970 by the wall clock. */
  readonly minute: number;
  /**
   * The gateway, or the link when no device is known: "device:<id>" or "link:<label>".
   * SPEC-QUESTION: section 6 does not say how the two are told apart in one column; this text
   * form does it, and keeps a link's label, since link ids are not kept across runs.
   */
  readonly via: string;
  readonly reason: RejectReason;
  readonly count: number;
  /** The first rejected packet's address, when it had one. */
  readonly address: number | null;
  /** The first 16 bytes of the first rejected packet. */
  readonly sample: Uint8Array;
}
