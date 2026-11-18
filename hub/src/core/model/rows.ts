/**
 * One row of each table of hub-design.md section 6, as the core reads it at start
 * (`DurableSnapshot`) and writes it (`StoreOp`, `AuditRecord`). Property names are the columns
 * in camel case; `db/schema.ts` declares the same tables for SQLite, and a test holds the two
 * to the same columns. `null` is SQL's NULL. Times: `*Ms` wall milliseconds, `*Mono`
 * microseconds on the monotonic clock of the boot in the row's `boot` column.
 */
import type { DecisionKind } from "./decisions.ts";
import type { RejectReason } from "./errors.ts";
import type {
  BootId,
  ClientId,
  DeviceId,
  GroupId,
  ImageId,
  ModeId,
  OutboxId,
  PersonId,
  RolloutId,
  ScheduleId,
  Seq,
  TokenId,
} from "./ids.ts";
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
  /**
   * Migration 3 (m3-updates-design section 7, D141): the new key a Key change carries, until the
   * device is heard under it; null when none. Pairing writes null: a new key from pairing ends
   * any key change (PR4).
   */
  readonly nextKey: Uint8Array | null;
  /** Migration 3: `Rekey.Required` after a restore until the device is heard under its new key. */
  readonly rekey: Rekey;
}

/** `device_keys.rekey` (D141). */
export const Rekey = { None: 0, Required: 1 } as const;
export type Rekey = (typeof Rekey)[keyof typeof Rekey];

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
  // M2 (m2-design.md section 4): made by the shell at the first start of M2, null until then.
  // `hub_keys` stays the shell's; the backup key is `upkeep`'s, in `backup_key`. Read by the
  // shell only; never part of a `DurableSnapshot` but for the public half.
  /** X25519, the hub's static key for apps (section 5). */
  readonly appStaticPrivate: Uint8Array | null;
  readonly appStaticPublic: Uint8Array | null;
  /** PKCS #8 of the TLS key (P-256). */
  readonly tlsPrivate: Uint8Array | null;
  /** DER. */
  readonly tlsCertificate: Uint8Array | null;
}

/** The hub's device-signing keys as the core sees them: the public half and the identity (§9). */
export type HubSigningKeys = Pick<HubKeysRow, "signingPublic" | "identity">;

/**
 * The hub's app keys as the core sees them (m2-design.md section 5): the static public key, whose
 * hash is the app identity; never a private key.
 */
export interface HubAppKeys {
  readonly appStaticPublic: Uint8Array;
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
  /**
   * Migration 3 (D141): an authentic packet under the device's old key while its `rekey` is set
   * (the `oldKeyPacket` message): recorded, never acted on, its replay window untouched. False
   * for every other packet.
   */
  readonly oldKey: boolean;
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

// M2 (m2-design.md section 4).

/** `clients.kind`. */
export const ClientKind = { Console: 0, Web: 1, Phone: 2 } as const;
export type ClientKind = (typeof ClientKind)[keyof typeof ClientKind];

/** `link_tokens.kind`. A restore token is never stored (section 9). */
export const TokenKind = { NewPerson: 0, OwnDevice: 1, Console: 2 } as const;
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

/** `modes.fixed` (D90). */
export const ModeFixed = { No: 0, Away: 1, Disarmed: 2 } as const;
export type ModeFixed = (typeof ModeFixed)[keyof typeof ModeFixed];

/** `schedules.missed_why` (section 7, D116). */
export const MissedWhy = { HubOff: 0, ClockNotSet: 1, ClockStepped: 2 } as const;
export type MissedWhy = (typeof MissedWhy)[keyof typeof MissedWhy];

/** `schedules.action`. */
export const ScheduleAction = { SwitchMode: 0, Arm: 1, Disarm: 2 } as const;
export type ScheduleAction = (typeof ScheduleAction)[keyof typeof ScheduleAction];

export interface PersonRow {
  readonly id: PersonId;
  readonly name: string;
  readonly createdMs: number;
  readonly removedMs: number | null;
  readonly revision: number;
}

export interface ClientRow {
  readonly id: ClientId;
  /** Null for the console (kind 0), which belongs to no person (section 7). */
  readonly personId: PersonId | null;
  /** The client's static public key (X25519); public, so the core may keep it (section 2). */
  readonly staticKey: Uint8Array;
  readonly kind: ClientKind;
  readonly name: string;
  readonly linkedByClient: ClientId | null;
  readonly createdMs: number;
  readonly removedMs: number | null;
  /** The highest `seq` accepted (section 5); 0 before the first. */
  readonly lastSeq: number;
  /** Routine. */
  readonly lastSeenMs: number | null;
  readonly backupKeyEpoch: number | null;
}

export interface ClientReplyRow {
  readonly clientId: ClientId;
  readonly seq: number;
  /** The reply as sent, UTF-8 JSON. */
  readonly reply: Uint8Array;
}

export interface PermissionRow {
  readonly personId: PersonId;
  readonly deviceId: DeviceId;
  readonly manage: boolean;
  readonly view: boolean;
}

export interface PersonRoleRow {
  readonly personId: PersonId;
  readonly manageUsers: boolean;
  readonly manageSystem: boolean;
  readonly revision: number;
}

export interface LinkTokenRow {
  readonly id: TokenId;
  /** 4 bytes: a 128-bit secret's lookup, or a typed code's token id. */
  readonly lookup: Uint8Array;
  readonly kind: TokenKind;
  readonly personId: PersonId | null;
  /** The name given in `link.create`'s `newPerson {name?}`; null when none was. */
  readonly personName: string | null;
  readonly createdByClient: ClientId | null;
  readonly createdBoot: BootId;
  readonly createdMono: Mono;
  readonly expiresAfterMs: number;
  readonly typed: boolean;
  readonly failures: number;
  readonly usedMs: number | null;
}

/** A token's pre-shared key: kept apart, as `device_keys` is; never in a snapshot but by `LinkSecrets`. */
export interface LinkSecretRow {
  readonly tokenId: TokenId;
  readonly psk: Uint8Array;
}

export interface GroupRow {
  readonly id: GroupId;
  readonly name: string;
  readonly allSirens: boolean;
  readonly revision: number;
}

export interface GroupMemberRow {
  readonly groupId: GroupId;
  readonly sensorId: DeviceId;
}

export interface GroupSirenRow {
  readonly groupId: GroupId;
  readonly sirenId: DeviceId;
}

export interface ModeRow {
  readonly id: ModeId;
  readonly name: string;
  readonly fixed: ModeFixed;
  readonly revision: number;
}

export interface ModeGroupRow {
  readonly modeId: ModeId;
  readonly groupId: GroupId;
}

export interface ScheduleRow {
  readonly id: ScheduleId;
  readonly name: string;
  readonly action: ScheduleAction;
  readonly modeId: ModeId | null;
  readonly groupId: GroupId | null;
  readonly sensorId: DeviceId | null;
  /** Minutes after midnight, local. */
  readonly localTime: number;
  /** A bit per weekday, Monday bit 0; 0 for a one-time entry. */
  readonly days: number;
  /** A one-time entry's date: days since 1970-01-01. */
  readonly date: number | null;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly lastRunMs: number | null;
  /** Days since 1970-01-01, local: an entry runs at most once per local date. */
  readonly lastRunLocalDate: number | null;
  /** The first occurrence missed since the entry last ran (D116), kept across a restart; null for none. */
  readonly missedDueMs: number | null;
  /** Why it was missed; null for none. */
  readonly missedWhy: MissedWhy | null;
  /** How many occurrences were missed in that gap; 0 for none. */
  readonly missedCount: number;
  readonly revision: number;
}

export interface HealthStateRow {
  readonly deviceId: DeviceId;
  readonly batteryLow: boolean;
  readonly tamperOpen: boolean;
}

export interface NotificationPrefsRow {
  readonly clientId: ClientId;
  /** A bit per optional category (`OPTIONAL_CATEGORIES`' order), 1 on. */
  readonly categories: number;
  readonly revision: number;
}

// M2's single rows, each written by one module only (section 4, "One writer per row").

/** Single row, `layout`'s: the current mode (D90). */
export interface ModeStateRow {
  /** Null when arming matches no mode. */
  readonly currentModeId: ModeId | null;
  /** Arming changed since the last switch: the app shows "Away, changed". */
  readonly modeModified: boolean;
}

/** Single row, `people`'s. */
export interface PeopleSettingsRow {
  /** D13: off by default. */
  readonly userManagement: boolean;
}

/** Single row, `schedules`'. */
export interface ScheduleStateRow {
  /** The zone last given by `timeZone`, or null before the first. */
  readonly timeZone: string | null;
}

/** `backup_state.last_result`. */
export const BackupResult = { Never: 0, Written: 1, Failed: 2 } as const;
export type BackupResult = (typeof BackupResult)[keyof typeof BackupResult];

/** Single row, `upkeep`'s (section 9, "Backup, export and restore"; D122). */
export interface BackupStateRow {
  /** Null: none chosen. */
  readonly folder: string | null;
  /** Null: `HubRules.backups.defaultHour`. */
  readonly hour: number | null;
  /** Null: `HubRules.backups.keep`. */
  readonly keep: number | null;
  /**
   * The last change to people, clients, permissions, user management, paired devices or the
   * backup key: the backup header's field (D122). Null before the first.
   */
  readonly lastChangeMs: number | null;
  /** The first such change no backup holds yet; null when none is due. */
  readonly dueSinceMs: number | null;
  /** The 1-hour warning was raised for this due backup, so it is raised once. */
  readonly overdueRaised: boolean;
  readonly newestName: string | null;
  readonly newestMs: number | null;
  readonly lastResult: BackupResult;
  readonly lastAttemptMs: number | null;
  /** The restore mark: set in a restored database, cleared when `restored` is recorded. */
  readonly restoredFromMs: number | null;
}

/** `backup_state` as migration 2 inserts it: no folder, nothing due. */
export const BACKUP_STATE_DEFAULTS: BackupStateRow = {
  folder: null,
  hour: null,
  keep: null,
  lastChangeMs: null,
  dueSinceMs: null,
  overdueRaised: false,
  newestName: null,
  newestMs: null,
  lastResult: BackupResult.Never,
  lastAttemptMs: null,
  restoredFromMs: null,
};

/**
 * Single row, `upkeep`'s: the backup key, made from the input's entropy at the first start of M2
 * and at each replacement (section 9). Kept apart as `link_secrets` is; never in a record.
 */
export interface BackupKeyRow {
  /** 32 bytes. */
  readonly key: Uint8Array;
  readonly epoch: number;
}

/** Single row, `upkeep`'s (section 9, "Hub updates"). */
export interface UpdateStateRow {
  readonly stagedVersion: string | null;
  readonly stagedMs: number | null;
  readonly approvedBy: string | null;
  readonly approvedMs: number | null;
  readonly switchingMs: number | null;
  readonly previousVersion: string | null;
  /** The last update's end: 0 none, 1 healthy, 2 rolled back (section 9). */
  readonly lastResult: UpdateResult;
  readonly lastResultMs: number | null;
}

/** `update_state.last_result`. */
export const UpdateResult = { None: 0, Healthy: 1, RolledBack: 2 } as const;
export type UpdateResult = (typeof UpdateResult)[keyof typeof UpdateResult];

/** One notification raised (section 7), 1 year. */
export interface NotificationRow {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly kind: string;
  readonly category: string;
  readonly critical: boolean;
  readonly deviceId: DeviceId | null;
  readonly causeSeq: Seq | null;
  /** Person ids, u32 LE each. */
  readonly recipients: Uint8Array;
  readonly detail: Uint8Array | null;
}

/** One client marking one notification read, 30 days. */
export interface NotificationReadRow {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly notificationSeq: Seq;
  readonly clientId: ClientId;
}

// ----- Migration 3: the joint step 0 of M3 and M4 (docs/m3-m4-plan.md) -----

/** `firmware_images.kind` (m3-updates-design section 4). */
export const ImageKind = { Official: 0, OwnBuild: 1 } as const;
export type ImageKind = (typeof ImageKind)[keyof typeof ImageKind];

/** One stored firmware image (m3-updates-design section 4), `firmware`'s; the bytes are a file. */
export interface FirmwareImageRow {
  readonly id: ImageId;
  /** The first 8 bytes of the image's SHA-256: the image id devices name. */
  readonly imageId: Uint8Array;
  readonly sha256: Uint8Array;
  /** As `devices.firmware`: major × 65,536 + minor × 256 + patch. */
  readonly version: number;
  readonly kind: ImageKind;
  /** Bit 1 sensor, bit 2 siren, bit 3 gateway, as the image header's roles byte. */
  readonly roles: number;
  /** The image's bytes, without the header. */
  readonly bytes: number;
  /** The 128-byte image header the hub signed. */
  readonly header: Uint8Array;
  /** Official: the release's manifest JSON and its signature, as hex; null for an own build. */
  readonly manifest: string | null;
  /** The payload's file in the data folder's `firmware/`. */
  readonly file: string;
  readonly addedMs: number;
  readonly addedBy: string;
  readonly removedMs: number | null;
}

/** `rollouts.stage`. */
export const RolloutStage = {
  Pilots: 0,
  Soak: 1,
  Rest: 2,
  Paused: 3,
  Done: 4,
  Cancelled: 5,
} as const;
export type RolloutStage = (typeof RolloutStage)[keyof typeof RolloutStage];

/** One rollout; at most one not ended. */
export interface RolloutRow {
  readonly id: RolloutId;
  readonly image: ImageId;
  /** Device ids, u32 LE each. */
  readonly devices: Uint8Array;
  readonly pilots: Uint8Array;
  readonly stage: RolloutStage;
  readonly approvedBy: string;
  readonly approvedMs: number;
  readonly soakUntilMs: number | null;
  /**
   * The reason it paused: a device's (an Update status reason 1 to 17, or 18 `noContact`), or the
   * rollout's own, `PILOT_FAILED_REASON` (19) or `ROLLED_BACK_REASON` (20); null while not paused.
   */
  readonly pausedReason: number | null;
  readonly pausedDevice: DeviceId | null;
  readonly endedMs: number | null;
}

/** `device_updates.state` (m3-updates-design section 4). */
export const DeviceUpdateState = {
  None: 0,
  Planned: 1,
  Offered: 2,
  Fetching: 3,
  Verified: 4,
  Installing: 5,
  OnTrial: 6,
  Confirmed: 7,
  RolledBack: 8,
  Refused: 9,
  Cancelled: 10,
} as const;
export type DeviceUpdateState = (typeof DeviceUpdateState)[keyof typeof DeviceUpdateState];

/** `device_updates.held`. */
export const UpdateHeld = {
  No: 0,
  Armed: 1,
  Battery: 2,
  WaitingTurn: 3,
  NeedsPhone: 4,
  CountdownAlarmOrSiteMove: 5,
  GatewayBusy: 6,
  KeyChange: 7,
} as const;
export type UpdateHeld = (typeof UpdateHeld)[keyof typeof UpdateHeld];

/** `device_updates.method`. */
export const UpdateMethod = { OwnLink: 0, JoinWifi: 1, Bluetooth: 2 } as const;
export type UpdateMethod = (typeof UpdateMethod)[keyof typeof UpdateMethod];

/** The hub's own reason beyond the Update status reasons 1 to 17: no Started after the go-ahead. */
export const NO_CONTACT_REASON = 18;

/**
 * `rollouts.paused_reason` only, beyond a device's reasons (m3-updates-design section 4): a pilot
 * failed in its soak, restarting by watchdog or fatal error or going silent. Its name in
 * `rolloutObject.paused.reason` is `pilotFailed` (`ROLLOUT_PAUSE_REASONS`, `@hsn/protocol/app`).
 */
export const PILOT_FAILED_REASON = 19;

/**
 * `rollouts.paused_reason` only: a device rolled back, its trial failed (section 4, "How a failed
 * update is reported"). Its name in `rolloutObject.paused.reason` is `rolledBack`.
 */
export const ROLLED_BACK_REASON = 20;

/** Each device's update state; every transition but `bytes` written now. */
export interface DeviceUpdateRow {
  readonly deviceId: DeviceId;
  readonly rolloutId: RolloutId | null;
  readonly state: DeviceUpdateState;
  readonly method: UpdateMethod;
  readonly held: UpdateHeld;
  /** Routine: written with the next flush. */
  readonly bytes: number;
  readonly attempts: number;
  /** An Update status reason (1 to 17), or 18 `noContact`; null for none. */
  readonly lastReason: number | null;
  readonly sinceMs: number;
  /** The Bluetooth session's nonce, 8 bytes, while one is in force. */
  readonly bleNonce: Uint8Array | null;
  readonly bleExpiresMs: number | null;
  readonly remindedMs: number | null;
}

/** Single row, `relay`'s (m4-design section 4). */
export interface RelaySettingsRow {
  /** Null: the deployment's default, which is "none" while it is a placeholder (RD 2). */
  readonly url: string | null;
  readonly revision: number;
}

/** `push_targets.platform`. */
export const PushPlatformCode = { Apns: 0, Fcm: 1 } as const;
export type PushPlatformCode = (typeof PushPlatformCode)[keyof typeof PushPlatformCode];
/** `push_targets.environment`. */
export const PushEnvironmentCode = { Production: 0, Development: 1 } as const;
export type PushEnvironmentCode = (typeof PushEnvironmentCode)[keyof typeof PushEnvironmentCode];

/** One phone's push target, `relay`'s: tokens, never keys. */
export interface PushTargetRow {
  readonly clientId: ClientId;
  /** 8 bytes. */
  readonly keyId: Uint8Array;
  readonly platform: PushPlatformCode;
  readonly environment: PushEnvironmentCode;
  readonly token: string;
  readonly registeredMs: number;
  /** When the push service answered `badToken`; null while valid. */
  readonly invalidMs: number | null;
}

/**
 * A phone's push key, 32 bytes, kept apart as `link_secrets` is: written now with `push.register`,
 * read at start by the `PushKeys` port, never kept in the core's slice.
 */
export interface PushKeyRow {
  readonly clientId: ClientId;
  readonly key: Uint8Array;
}

/** One push waiting for the relay (D102): durable as the notification it carries. */
export interface PushOutboxRow {
  readonly id: OutboxId;
  readonly notificationSeq: Seq;
  readonly clientId: ClientId;
  readonly createdMs: number;
  readonly attempts: number;
  /**
   * Whether any sensor was armed when the notification was raised (0 or 1), so a push sent after a
   * restart says what it would have said.
   */
  readonly armed: 0 | 1;
  /**
   * The small JSON of decision facts the push's `detail` and mode name are built from (UTF-8 text),
   * or null when it has none.
   */
  readonly facts: string | null;
}
