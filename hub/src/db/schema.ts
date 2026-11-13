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
import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
