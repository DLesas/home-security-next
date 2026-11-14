/**
 * The database (hub-design.md section 6): every table, for SQLite through Drizzle. drizzle-kit
 * generates the migrations in `hub/drizzle/` from this file. Times are integers: `*_ms` wall
 * milliseconds, `*_mono` microseconds on one boot's monotonic clock, always with a `boot`
 * column. Bodies and device texts are raw bytes. The only indexes are primary keys and the two
 * unique keys on `devices`. The core's row types (`core/model/rows.ts`) have the same columns,
 * which a test checks.
 *
 * `loss_daily` and `rejects` are tables without row id (section 6). Drizzle cannot declare that,
 * so the first migration's two CREATE TABLE statements end in `WITHOUT ROWID`, added by hand
 * after generation; a test checks it.
 */
import { isNull } from "drizzle-orm";
import { blob, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const bytes = (name: string) => blob(name, { mode: "buffer" });
const flag = (name: string) => integer(name, { mode: "boolean" });

/** The columns every audit row begins with: its sequence number as row id, its time and trust. */
const stamped = () => ({
  seq: integer("seq").primaryKey(),
  atMs: integer("at_ms").notNull(),
  clockOk: flag("clock_ok").notNull(),
});

// Configuration and durable state, written now.

export const devices = sqliteTable("devices", {
  id: integer("id").primaryKey(),
  address: integer("address").notNull().unique(),
  role: integer("role").notNull(),
  name: text("name").notNull().unique(),
  chipId: bytes("chip_id").notNull(),
  firmware: integer("firmware").notNull(),
  development: flag("development").notNull(),
  state: integer("state").notNull(),
  addedMs: integer("added_ms").notNull(),
  removedMs: integer("removed_ms"),
});

export const deviceKeys = sqliteTable("device_keys", {
  deviceId: integer("device_id").primaryKey(),
  key: bytes("key").notNull(),
});

export const sendCounters = sqliteTable("send_counters", {
  deviceId: integer("device_id").primaryKey(),
  resumePoint: integer("resume_point").notNull(),
});

/** Single row. */
export const hubKeys = sqliteTable("hub_keys", {
  signingPrivate: bytes("signing_private").notNull(),
  signingPublic: bytes("signing_public").notNull(),
  identity: bytes("identity").notNull(),
  // Added by migration 2 (m2-design.md section 4), so last; made at the first start of M2 by the
  // shell, so null until then. The table stays the shell's; the core sees only the public key.
  appStaticPrivate: bytes("app_static_private"),
  appStaticPublic: bytes("app_static_public"),
  /** PKCS #8. */
  tlsPrivate: bytes("tls_private"),
  /** DER. */
  tlsCertificate: bytes("tls_certificate"),
});

/** Single row: site settings and the site move (D115); all the move's columns are written now. */
export const site = sqliteTable("site", {
  channel: integer("channel"),
  rateMask: integer("rate_mask").notNull(),
  moveId: integer("move_id").notNull(),
  moveStage: integer("move_stage").notNull(),
  moveChannel: integer("move_channel"),
  moveRate: integer("move_rate"),
  moveActor: text("move_actor"),
  moveRequestedMs: integer("move_requested_ms"),
  moveForced: flag("move_forced").notNull(),
  moveSwitchedBoot: integer("move_switched_boot"),
  moveSwitchedMono: integer("move_switched_mono"),
  wifiName: bytes("wifi_name").notNull(),
  wifiPassword: bytes("wifi_password").notNull(),
  countdownDefaultS: integer("countdown_default_s").notNull(),
  autoStopS: integer("auto_stop_s").notNull(),
  replyPowerDbm: integer("reply_power_dbm").notNull(),
  sirenPowerDbm: integer("siren_power_dbm").notNull(),
  retentionRoutineDays: integer("retention_routine_days").notNull(),
  retentionEventDays: integer("retention_event_days").notNull(),
});

export const sensorConfig = sqliteTable("sensor_config", {
  deviceId: integer("device_id").primaryKey(),
  arm: integer("arm").notNull(),
  armedBoot: integer("armed_boot"),
  armedMono: integer("armed_mono"),
  countdownS: integer("countdown_s").notNull(),
  heartbeatUnits: integer("heartbeat_units").notNull(),
  linkCheckEvery: integer("link_check_every").notNull(),
  sendRate: integer("send_rate").notNull(),
  replyRate: integer("reply_rate").notNull(),
  replyRateFixed: flag("reply_rate_fixed").notNull(),
  correctionUnits: integer("correction_units").notNull(),
  correctionFixed: flag("correction_fixed").notNull(),
  nextChannel: integer("next_channel").notNull(),
  nextRate: integer("next_rate").notNull(),
  moveConfirmed: integer("move_confirmed").notNull(),
  moveFollowed: integer("move_followed").notNull(),
  version: integer("version").notNull(),
  versionHistory: bytes("version_history").notNull(),
});

export const sirenConfig = sqliteTable("siren_config", {
  deviceId: integer("device_id").primaryKey(),
  version: integer("version").notNull(),
  wifiIntervalS: integer("wifi_interval_s").notNull(),
  loraCheckUnits: integer("lora_check_units").notNull(),
  maxSoundS: integer("max_sound_s").notNull(),
  sendRate: integer("send_rate").notNull(),
  commandRate: integer("command_rate").notNull(),
  siteChannel: integer("site_channel").notNull(),
  versionHistory: bytes("version_history").notNull(),
});

export const gatewayConfig = sqliteTable("gateway_config", {
  deviceId: integer("device_id").primaryKey(),
  version: integer("version").notNull(),
  statusIntervalS: integer("status_interval_s").notNull(),
  interferenceDb: integer("interference_db").notNull(),
  interferenceS: integer("interference_s").notNull(),
  defaultPowerDbm: integer("default_power_dbm").notNull(),
  sirenPowerDbm: integer("siren_power_dbm").notNull(),
});

export const countdowns = sqliteTable("countdowns", {
  sensorId: integer("sensor_id").primaryKey(),
  boot: integer("boot").notNull(),
  openedMono: integer("opened_mono").notNull(),
  deadlineMono: integer("deadline_mono").notNull(),
  newestCounter: integer("newest_counter").notNull(),
  replyGatewayId: integer("reply_gateway_id"),
  replyRate: integer("reply_rate").notNull(),
  causeSeq: integer("cause_seq").notNull(),
});

/** Single row while an alarm runs. */
export const alarm = sqliteTable("alarm", {
  boot: integer("boot").notNull(),
  startedMono: integer("started_mono").notNull(),
  causeSeq: integer("cause_seq").notNull(),
});

export const alarmTriggers = sqliteTable("alarm_triggers", {
  sensorId: integer("sensor_id").primaryKey(),
  kind: integer("kind").notNull(),
  boot: integer("boot").notNull(),
  atMono: integer("at_mono").notNull(),
});

export const alarmSirens = sqliteTable("alarm_sirens", {
  sirenId: integer("siren_id").primaryKey(),
  boot: integer("boot").notNull(),
  untilMono: integer("until_mono").notNull(),
  commanded: flag("commanded").notNull(),
});

export const boots = sqliteTable("boots", {
  id: integer("id").primaryKey(),
  startedMs: integer("started_ms").notNull(),
  startedTrusted: flag("started_trusted").notNull(),
  previousExit: text("previous_exit", { enum: ["clean", "crash", "unknown"] }).notNull(),
  cause: text("cause"),
  cleanStopMs: integer("clean_stop_ms"),
  trustedAtMono: integer("trusted_at_mono"),
  clockStepMs: integer("clock_step_ms"),
});

// Readings and estimates, routine.

/**
 * Device 0's row is the commit mark. SPEC-QUESTION: `clock_ok` is not in section 6's list; it
 * holds the commit mark's wall trust, which section 5 says the mark keeps.
 */
export const deviceState = sqliteTable("device_state", {
  deviceId: integer("device_id").primaryKey(),
  boot: integer("boot").notNull(),
  lastSeenMono: integer("last_seen_mono").notNull(),
  lastSeenMs: integer("last_seen_ms").notNull(),
  clockOk: flag("clock_ok").notNull(),
  window: bytes("window"),
  reading: bytes("reading"),
  rssi: integer("rssi"),
  snrQ: integer("snr_q"),
  bestGatewayId: integer("best_gateway_id"),
  uptimeS: integer("uptime_s"),
  estimates: bytes("estimates"),
});

/** Without row id (hand edit in the migration). */
export const lossDaily = sqliteTable(
  "loss_daily",
  {
    deviceId: integer("device_id").notNull(),
    day: integer("day").notNull(),
    received: integer("received").notNull(),
    expected: integer("expected").notNull(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.day] })],
);

// The audit record.

const rxColumns = () => ({
  ...stamped(),
  deviceId: integer("device_id").notNull(),
  type: integer("type").notNull(),
  counter: integer("counter").notNull(),
  path: integer("path").notNull(),
  gatewayId: integer("gateway_id"),
  gwUs: integer("gw_us"),
  rssi: integer("rssi"),
  snrQ: integer("snr_q"),
  rate: integer("rate"),
  body: bytes("body").notNull(),
  // Added by migration 1, so last (D110: the carrying gateway packet's counter).
  gwCounter: integer("gw_counter"),
});

const txColumns = () => ({
  ...stamped(),
  deviceId: integer("device_id").notNull(),
  type: integer("type").notNull(),
  counter: integer("counter").notNull(),
  path: integer("path").notNull(),
  gatewayId: integer("gateway_id"),
  requestCounter: integer("request_counter"),
  rate: integer("rate"),
  power: integer("power"),
  outcome: integer("outcome").notNull(),
  gwSentUs: integer("gw_sent_us"),
  body: bytes("body").notNull(),
  // Added by migration 1, so last (D110: the reporting transmit result's counter).
  resultCounter: integer("result_counter"),
});

export const rxRoutine = sqliteTable("rx_routine", rxColumns());
export const rxEvent = sqliteTable("rx_event", rxColumns());
export const txRoutine = sqliteTable("tx_routine", txColumns());
export const txEvent = sqliteTable("tx_event", txColumns());

export const decisions = sqliteTable("decisions", {
  ...stamped(),
  kind: text("kind").notNull(),
  deviceId: integer("device_id"),
  causeSeq: integer("cause_seq"),
  value: integer("value"),
  detail: bytes("detail"),
});

export const deviceLog = sqliteTable("device_log", {
  ...stamped(),
  deviceId: integer("device_id").notNull(),
  counter: integer("counter").notNull(),
  madeMs: integer("made_ms").notNull(),
  level: integer("level").notNull(),
  code: integer("code").notNull(),
  text: bytes("text").notNull(),
  repeatOf: integer("repeat_of"),
});

export const hubEvents = sqliteTable("hub_events", {
  ...stamped(),
  level: text("level", { enum: ["debug", "info", "warning", "critical"] }).notNull(),
  origin: text("origin").notNull(),
  code: text("code").notNull(),
  message: text("message").notNull(),
  detail: text("detail"),
});

export const commands = sqliteTable("commands", {
  ...stamped(),
  actor: text("actor").notNull(),
  kind: text("kind").notNull(),
  args: text("args").notNull(),
  outcome: text("outcome").notNull(),
  detail: text("detail"),
});

/**
 * Without row id (hand edit in the migration). SPEC-QUESTION: `via` is text, "device:<id>" or
 * "link:<label>", since section 6 does not say how one integer column tells the two apart.
 */
export const rejects = sqliteTable(
  "rejects",
  {
    minute: integer("minute").notNull(),
    via: text("via").notNull(),
    reason: text("reason").notNull(),
    count: integer("count").notNull(),
    address: integer("address"),
    sample: bytes("sample").notNull(),
  },
  (table) => [primaryKey({ columns: [table.minute, table.via, table.reason] })],
);

// M2 (m2-design.md section 4): configuration and small state, written now unless marked. Every
// editable object has a `revision`, raised by one at each change. Tables of pairs are without row
// id (hand edit in migration 2, as for migration 0's two).

export const people = sqliteTable(
  "people",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    createdMs: integer("created_ms").notNull(),
    removedMs: integer("removed_ms"),
    revision: integer("revision").notNull(),
  },
  // Unique among those not removed: a removed person's name may be given again.
  (table) => [uniqueIndex("people_name_live").on(table.name).where(isNull(table.removedMs))],
);

export const clients = sqliteTable("clients", {
  id: integer("id").primaryKey(),
  /** Null for the console (kind 0). */
  personId: integer("person_id"),
  staticKey: bytes("static_key").notNull().unique(),
  /** 0 console, 1 web, 2 phone. */
  kind: integer("kind").notNull(),
  name: text("name").notNull(),
  linkedByClient: integer("linked_by_client"),
  createdMs: integer("created_ms").notNull(),
  removedMs: integer("removed_ms"),
  lastSeq: integer("last_seq").notNull(),
  /** Routine. */
  lastSeenMs: integer("last_seen_ms"),
  /** The backup key's epoch it holds; phones only. */
  backupKeyEpoch: integer("backup_key_epoch"),
});

/** Without row id. The last 16 per client ‡, older ones deleted in the same commit. */
export const clientReplies = sqliteTable(
  "client_replies",
  {
    clientId: integer("client_id").notNull(),
    seq: integer("seq").notNull(),
    /** The reply as sent, UTF-8 JSON. */
    reply: bytes("reply").notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.seq] })],
);

/** Without row id. */
export const permissions = sqliteTable(
  "permissions",
  {
    personId: integer("person_id").notNull(),
    deviceId: integer("device_id").notNull(),
    manage: flag("manage").notNull(),
    view: flag("view").notNull(),
  },
  (table) => [primaryKey({ columns: [table.personId, table.deviceId] })],
);

export const personRoles = sqliteTable("person_roles", {
  personId: integer("person_id").primaryKey(),
  manageUsers: flag("manage_users").notNull(),
  manageSystem: flag("manage_system").notNull(),
  revision: integer("revision").notNull(),
});

export const linkTokens = sqliteTable(
  "link_tokens",
  {
    id: integer("id").primaryKey(),
    /** 4 bytes: a 128-bit secret's lookup, or a typed code's token id. */
    lookup: bytes("lookup").notNull(),
    /** 0 a new person, 1 a device of an existing person, 2 console; a restore token is never stored. */
    kind: integer("kind").notNull(),
    personId: integer("person_id"),
    /** Null for the console and the installer. */
    createdByClient: integer("created_by_client"),
    createdBoot: integer("created_boot").notNull(),
    createdMono: integer("created_mono").notNull(),
    expiresAfterMs: integer("expires_after_ms").notNull(),
    typed: flag("typed").notNull(),
    failures: integer("failures").notNull(),
    usedMs: integer("used_ms"),
  },
  // Unique among unused tokens.
  (table) => [
    uniqueIndex("link_tokens_lookup_unused").on(table.lookup).where(isNull(table.usedMs)),
  ],
);

/** Kept apart, as `device_keys` is: no query of `link_tokens` reads a key. */
export const linkSecrets = sqliteTable("link_secrets", {
  tokenId: integer("token_id").primaryKey(),
  psk: bytes("psk").notNull(),
});

export const groups = sqliteTable("groups", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** 1: every siren, the default (AL2a). */
  allSirens: flag("all_sirens").notNull(),
  revision: integer("revision").notNull(),
});

/** Without row id. */
export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: integer("group_id").notNull(),
    sensorId: integer("sensor_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.sensorId] })],
);

/** Without row id. Used when `all_sirens` is 0. */
export const groupSirens = sqliteTable(
  "group_sirens",
  {
    groupId: integer("group_id").notNull(),
    sirenId: integer("siren_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.sirenId] })],
);

export const modes = sqliteTable("modes", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** 0 user-made, 1 Away, 2 Disarmed (D90). */
  fixed: integer("fixed").notNull(),
  revision: integer("revision").notNull(),
});

/** Without row id. */
export const modeGroups = sqliteTable(
  "mode_groups",
  {
    modeId: integer("mode_id").notNull(),
    groupId: integer("group_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.modeId, table.groupId] })],
);

export const schedules = sqliteTable("schedules", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  /** 0 switch to mode, 1 arm, 2 disarm. */
  action: integer("action").notNull(),
  // One of the three.
  modeId: integer("mode_id"),
  groupId: integer("group_id"),
  sensorId: integer("sensor_id"),
  /** Minutes after midnight. */
  localTime: integer("local_time").notNull(),
  /** A bit per weekday, Monday bit 0; 0 for a one-time entry. */
  days: integer("days").notNull(),
  /** For a one-time entry: days since 1970-01-01. */
  date: integer("date"),
  enabled: flag("enabled").notNull(),
  createdBy: text("created_by").notNull(),
  lastRunMs: integer("last_run_ms"),
  lastRunLocalDate: integer("last_run_local_date"),
  revision: integer("revision").notNull(),
});

export const healthState = sqliteTable("health_state", {
  deviceId: integer("device_id").primaryKey(),
  batteryLow: flag("battery_low").notNull(),
  tamperOpen: flag("tamper_open").notNull(),
});

export const notificationPrefs = sqliteTable("notification_prefs", {
  clientId: integer("client_id").primaryKey(),
  /** A bit per optional category, 1 on. */
  categories: integer("categories").notNull(),
  revision: integer("revision").notNull(),
});

/** Single row. */
// M2's single rows, each written by one module only (section 4, "One writer per row"); migration 2
// inserts each but `backup_key`, which `upkeep` makes at the first start.

/** Single row, `layout`'s. */
export const modeState = sqliteTable("mode_state", {
  /** The current mode (D90), or null when arming matches no mode. */
  currentModeId: integer("current_mode_id"),
  /** 1 when arming has changed since the last switch ("Away, changed"). */
  modeModified: flag("mode_modified").notNull(),
});

/** Single row, `people`'s. */
export const peopleSettings = sqliteTable("people_settings", {
  /** D13: off by default; every person then has every permission. */
  userManagement: flag("user_management").notNull(),
});

/** Single row, `schedules`'. */
export const scheduleState = sqliteTable("schedule_state", {
  /** The zone last given by `timeZone`, null before the first. */
  timeZone: text("time_zone"),
});

/** Single row, `upkeep`'s (section 9, D122). */
export const backupState = sqliteTable("backup_state", {
  /** Null: none chosen. */
  folder: text("folder"),
  /** Null: 03:00 ‡. */
  hour: integer("hour"),
  /** Null: 20 ‡. */
  keep: integer("keep"),
  /** The last change a backup must hold: the header's field (D122). */
  lastChangeMs: integer("last_change_ms"),
  /** The first change no backup holds yet; null when none is due. */
  dueSinceMs: integer("due_since_ms"),
  /** 1 once the 1-hour warning is raised, so it is raised once. */
  overdueRaised: flag("overdue_raised").notNull(),
  newestName: text("newest_name"),
  newestMs: integer("newest_ms"),
  /** 0 never, 1 written, 2 failed. */
  lastResult: integer("last_result").notNull(),
  lastAttemptMs: integer("last_attempt_ms"),
  /** The restore mark: set in a restored database, cleared when `restored` is recorded. */
  restoredFromMs: integer("restored_from_ms"),
});

/** Single row, `upkeep`'s: the backup key. Kept apart as `link_secrets` is; never in a record. */
export const backupKey = sqliteTable("backup_key", {
  key: bytes("key").notNull(),
  epoch: integer("epoch").notNull(),
});

/** Single row, `upkeep`'s. */
export const updateState = sqliteTable("update_state", {
  stagedVersion: text("staged_version"),
  stagedMs: integer("staged_ms"),
  approvedBy: text("approved_by"),
  approvedMs: integer("approved_ms"),
  switchingMs: integer("switching_ms"),
  previousVersion: text("previous_version"),
});

// M2's audit tables (section 4): HD 6's rules.

export const notifications = sqliteTable("notifications", {
  ...stamped(),
  kind: text("kind").notNull(),
  category: text("category").notNull(),
  critical: flag("critical").notNull(),
  deviceId: integer("device_id"),
  causeSeq: integer("cause_seq"),
  /** Person ids, u32 LE each. */
  recipients: bytes("recipients").notNull(),
  detail: bytes("detail"),
});

export const notificationReads = sqliteTable("notification_reads", {
  ...stamped(),
  notificationSeq: integer("notification_seq").notNull(),
  clientId: integer("client_id").notNull(),
});
