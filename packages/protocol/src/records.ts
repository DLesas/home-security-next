/**
 * The audit record as JSON (hub-design.md sections 6 and 9; m2-design.md section 6): what
 * `hsn log` reads and `--follow` streams, what the bench's lockstep `idle` carries, and the `row`
 * of the app's `history.query` and `record` event. One schema serves `hsn` and the app. One
 * variant per kind of the core's `AuditRecord`, one field per column, bytes as hex. Readers decode
 * bodies with `@hsn/protocol` when they show them.
 */
import { z } from "zod";

/** Bytes as lowercase hex with no separators, as the protocol's vector files write them. */
const hexBytes = z.string().regex(/^(?:[0-9a-f]{2})*$/, "lowercase hex, two digits a byte");

/** A whole number of milliseconds or a sequence number; never negative. */
const time = z.int().min(0);
const integer = z.int();
const nullableInteger = z.int().nullable();
const seq = time;

/** The columns every audit row begins with. */
const stamped = { seq, atMs: time, clockOk: z.boolean() };

const packetTable = z.enum(["routine", "event"]);

const rxRow = z
  .object({
    ...stamped,
    deviceId: integer,
    type: integer,
    counter: integer,
    path: integer,
    gatewayId: nullableInteger,
    gwUs: nullableInteger,
    rssi: nullableInteger,
    snrQ: nullableInteger,
    rate: nullableInteger,
    body: hexBytes,
    /** The counter of the gateway's forwarded packet that carried it; null for none (D110). */
    gwCounter: nullableInteger,
    /**
     * Migration 3 (D141): a packet under the device's old key, never acted on. Absent in a record
     * written before it (a recorded lockstep session's): false.
     */
    oldKey: z.boolean().default(false),
  })
  .readonly();

const txRow = z
  .object({
    ...stamped,
    deviceId: integer,
    type: integer,
    counter: integer,
    path: integer,
    gatewayId: nullableInteger,
    requestCounter: nullableInteger,
    rate: nullableInteger,
    power: nullableInteger,
    outcome: integer,
    gwSentUs: nullableInteger,
    body: hexBytes,
    /** The counter of the gateway's transmit result that reported it; null for none (D110). */
    resultCounter: nullableInteger,
  })
  .readonly();

const decisionRow = z
  .object({
    ...stamped,
    /** A `DecisionKind` of the core's model. */
    kind: z.string(),
    deviceId: nullableInteger,
    causeSeq: nullableInteger,
    value: z.number().nullable(),
    detail: hexBytes.nullable(),
  })
  .readonly();

const deviceLogRow = z
  .object({
    ...stamped,
    deviceId: integer,
    counter: integer,
    madeMs: integer,
    level: integer,
    code: integer,
    text: hexBytes,
    repeatOf: nullableInteger,
  })
  .readonly();

const hubEventRow = z
  .object({
    ...stamped,
    level: z.enum(["debug", "info", "warning", "critical"]),
    origin: z.string(),
    code: z.string(),
    message: z.string(),
    detail: z.string().nullable(),
  })
  .readonly();

const commandRow = z
  .object({
    ...stamped,
    actor: z.string(),
    kind: z.string(),
    args: z.string(),
    outcome: z.string(),
    detail: z.string().nullable(),
  })
  .readonly();

const rejectRow = z
  .object({
    minute: integer,
    via: z.string(),
    reason: z.string(),
    count: integer,
    address: nullableInteger,
    sample: hexBytes,
  })
  .readonly();

/**
 * A device's day of packets (`loss_daily`, HD 6), keyed by (`deviceId`, `day`, days since the
 * epoch in UTC): no `seq`, as `reject` has none. Only the history export carries it (section 9).
 */
const lossDailyRow = z
  .object({ deviceId: integer, day: integer, received: integer, expected: integer })
  .readonly();

/** M2 (m2-design.md section 4): a notification raised. */
const notificationRow = z
  .object({
    ...stamped,
    kind: z.string(),
    category: z.string(),
    critical: z.boolean(),
    deviceId: nullableInteger,
    causeSeq: nullableInteger,
    /** Person ids, u32 LE each. */
    recipients: hexBytes,
    detail: hexBytes.nullable(),
  })
  .readonly();

/** M2: a client marked a notification read. */
const notificationReadRow = z
  .object({ ...stamped, notificationSeq: integer, clientId: integer })
  .readonly();

const auditRecordKinds = [
  z.object({ kind: z.literal("rx"), table: packetTable, row: rxRow }).readonly(),
  z.object({ kind: z.literal("tx"), table: packetTable, row: txRow }).readonly(),
  z.object({ kind: z.literal("decision"), row: decisionRow }).readonly(),
  z.object({ kind: z.literal("deviceLog"), row: deviceLogRow }).readonly(),
  z.object({ kind: z.literal("hubEvent"), row: hubEventRow }).readonly(),
  z.object({ kind: z.literal("command"), row: commandRow }).readonly(),
  z.object({ kind: z.literal("reject"), row: rejectRow }).readonly(),
  z.object({ kind: z.literal("notification"), row: notificationRow }).readonly(),
  z.object({ kind: z.literal("notificationRead"), row: notificationReadRow }).readonly(),
] as const;

/**
 * One record as JSON: an audit record as `hsn log --json` and `history.query` give it, or a
 * `lossDaily` row, which only the history export carries (section 9, `hsn-history/1`).
 */
export const recordJson = z.discriminatedUnion("kind", [
  ...auditRecordKinds,
  z.object({ kind: z.literal("lossDaily"), row: lossDailyRow }).readonly(),
]);

export type RecordJson = z.infer<typeof recordJson>;

/** One audit record as JSON (`hsn log`, `history.query`, the lockstep wire): no `lossDaily`. */
export const auditRecordJson = z.discriminatedUnion("kind", [...auditRecordKinds]);

export type AuditRecordJson = z.infer<typeof auditRecordJson>;

// ----- The decision kinds and the hub event kinds (m2-design.md section 11, "Step 1, wave 2"):
// here, beside `recordJson`, so the hub, the app and its translation files share one list. -----

/**
 * Every decision the hub records (hub-design.md sections 7 and 8, D110), by its snake-case
 * name, which is `decisions.kind`. The first group is the firmware bench's `HubAction`
 * (firmware/platform/host/include/hsn/host/hub_log.hpp), name for name, so the bench's system
 * tests can ask the real hub the same questions (section 11); a test checks it stays a superset.
 * Each kind's `value` and `detail` are laid out exactly in section 6.
 */
export const DECISION_KINDS = [
  // The bench's HubAction, in its order.
  /** A sensor was armed (`hsn arm`), with the actor. */
  "armed",
  /** A sensor was disarmed (`hsn disarm`), with the actor. */
  "disarmed",
  /** A reply to a sensor was sealed and handed to a path. value: its counter. */
  "reply",
  /** A heartbeat reply was skipped: radio busy, too late to ask, or its gateway gone (section 8). */
  "reply_skipped",
  /** A packet could not start before its latest moment (a transmit result "too late"). */
  "too_late",
  /** A door opened while armed: the countdown runs. value: seconds left. */
  "countdown_started",
  /** Another report of an opening whose countdown runs. value: seconds left. */
  "countdown_continued",
  /**
   * A late report: the countdown had ended; sirens sound for what is left. value: seconds (D106);
   * detail: when the countdown ended or would have ended, as `eventAtDetail` writes it (D102).
   */
  "late_report_sirens",
  /** A report so late even the sirens' time has passed. value: the opening's wall time, whole seconds since 1970 UTC. */
  "late_report_notification",
  /** A door report while disarmed or waiting: recorded only (AL2b). */
  "report_while_disarmed",
  /**
   * An alarm started: a countdown ended while armed, or a zero countdown (critical). detail: none
   * when it ended on time; when it is raised at a start for a countdown that ended before the stop
   * (D113), when it ended, as `eventAtDetail` writes it (D102).
   */
  "alarm",
  /** A disarmed notice was sent. value: the counter it is bound to (D24). */
  "disarmed_notice",
  /** A sensor said its local alarm sounded (flag bit 5, DS6, D88). */
  "local_alarm_reported",
  /** A siren command was issued. value: the action; detail: the command body (action, seconds u16 LE). */
  "siren_command",
  /** Siren settings were issued. value: the settings version. */
  "siren_settings",
  /** A siren report confirmed the command or settings in flight. value: its path (`rx.path`: 0 LoRa, 1 Wi-Fi, 2 USB). */
  "siren_confirmed",
  /** A minute passed without confirmation (§7): a warning. */
  "siren_unreachable",
  /** A gateway's hello was answered with a welcome. */
  "gateway_welcomed",
  /** Gateway settings were sent. value: the settings version. */
  "gateway_settings",
  /** A gateway reported a transmit request's result. value: `TxOutcome`. */
  "transmit_result",
  /** A packet had no gateway to go through (section 8, "Which gateway a packet goes through"). */
  "no_path",
  // The bench's site move (D115).
  /** A move was asked for. value: the move id; detail: target channel, then rate, 0xFF for "stays". */
  "move_requested",
  /** A sensor's packets show a version that carries the move. */
  "move_confirmed",
  /** A switch was forced without `--yes` while this sensor has not confirmed: nothing switched. */
  "move_unconfirmed",
  /** A switch is due during a countdown or an alarm: it goes when they end (section 8). */
  "move_switch_waiting",
  /** The site switched to the new channel and rate; value 1 when forced. */
  "move_switched",
  /** A forced switch left sensors behind, each to be paired again: critical. */
  "move_forced",
  /** The move was cancelled while announcing. */
  "move_cancelled",
  /** A device was first heard on the new settings after the switch. */
  "device_followed",
  /** Every device followed, or the grace ran out; names any that did not. */
  "move_done",

  // Decisions the hub design names beyond the bench's.
  /** A door change count advanced by more than the reports accepted (§7, section 8): a warning. */
  "door_changes_missed",
  /** A heartbeat showed a door state the hub did not expect (section 8): a warning. */
  "door_state_unexpected",
  /** A sensor now waits for its door to close: open at arming (D50, D114) or after an alarm (D67). */
  "waits_for_door_to_close",
  /** Another trigger joined the running alarm (section 7, D95). */
  "alarm_trigger_added",
  /** The alarm ended: every trigger disarmed (D95), or every siren's time passed (D67). */
  "alarm_ended",
  /** A restart with the downtime unknown left a saved alarm's sirens off (section 5, D113): critical. */
  "alarm_may_be_cut_short",
  /** After a restart, a siren reporting sounding was adopted, not commanded again (D80). */
  "siren_adopted",
  /** A siren's Wi-Fi path was lost (D73): a warning. */
  "siren_wifi_lost",
  /** A siren's LoRa path was lost while Wi-Fi works (D73): a warning. */
  "siren_lora_lost",
  /** A siren on LoRa alone went silent (D52, §7): critical while any sensor is armed. */
  "siren_silent",
  /** A sensor went silent (D107, HB25): critical while armed. */
  "sensor_silent",
  /** A sensor's loss over 7 days is above 20 % (D107). value: the loss in parts per thousand. */
  "poor_link",
  /** A gateway sent nothing for 60 s (§7, D97), naming the sensors only it heard. */
  "gateway_offline",
  /** A gateway reported interference starting (GW11, D82): critical while armed. */
  "interference_started",
  /** A gateway reported interference ending (GW11, D82). */
  "interference_ended",
  /** The hub judged a gateway's noise as interference against its baseline (section 8). */
  "noise_interference_started",
  /** The hub's own interference judgement ended (section 8). */
  "noise_interference_ended",
  /** A gateway's learned normal noise is at least the baseline plus the alert level (§14). */
  "interference_learned_as_normal",
  /** Over half of a gateway's received packets failed the radio's CRC (section 8): a warning. */
  "damaged_packets",
  /** A gateway's new session was proven (section 8). value: the proving packet's counter. */
  "gateway_session_proven",
  /** The hub closed a gateway's link (section 8). value: 0 replaced by a newer session, 1 not proven. */
  "gateway_link_closed",
  /** A device sent Started. value: its reset cause; the last fatal error is in the cause's `rx` row (FW5). */
  "device_started",

  // The site move, beyond the bench.
  /** A sensor has not confirmed after 4 of its heartbeat intervals †: a warning naming it. */
  "move_stalled",

  // M2 (m2-design.md sections 1, 4, 7 and 9). Each module's own kinds; values and details are
  // laid out by their owners in step 1, and written into HD 6's tables with the code.
  /** layout: a mode switch, before the per-sensor `armed` and `disarmed` (section 1). */
  "mode_switched",
  /** layout: an arming action that is not a switch (a group, a sensor, `mine`): its notice's summary. */
  "arming_changed",
  /** schedules: an entry ran, naming what it armed, disarmed, left waiting and found low. */
  "schedule_ran",
  /** schedules: an entry fell due while the hub was off or its clock unset (D116): a warning. */
  "schedule_missed",
  /** schedules: a disarm during a countdown or an alarm left its triggers armed (D117): a warning. */
  "schedule_held_back",
  /** schedules: no entry runs on an untrusted clock: one warning. */
  "schedules_waiting_for_clock",
  /** people (section 4): written now with the change. */
  "person_added",
  "person_removed",
  "client_linked",
  "client_removed",
  /** people: a rename, written now, detail the old and new names; a change a backup must hold. */
  "person_renamed",
  "client_renamed",
  "permissions_changed",
  "user_management_changed",
  /** health (section 7): low battery at 10% or below, cleared above 15% (HB33). */
  "battery_low",
  "battery_ok",
  /** health: cover tamper (D9). */
  "tamper_opened",
  "tamper_closed",
  /** health: a cover in a state the hub did not expect (D114). value: 1 open, 0 closed; once per change. */
  "cover_state_unexpected",
  /** health: a pairing or reset hold while armed (HB10, D89). */
  "long_press_ignored",
  /**
   * upkeep: restore and updates (section 9), decisions because they are the hub's own choices
   * with consequences people are told of (section 7). `update_switching` is recorded and announced
   * to the apps as a `hub` event, not notified: the hub stops a moment later.
   */
  "restored",
  "update_staged",
  "update_switching",
  "update_healthy",
  "update_rolled_back",
  /** upkeep: backups (section 9), each notified to manage system and not to be turned off ‡. */
  "backup_overdue",
  "backup_key_replaced",
  "backup_folder_on_data_disk",
  /**
   * upkeep: no backup folder is chosen, nothing is backed up (section 9): once, at the first change
   * a backup would hold, and not again until a folder is chosen; instead of `backup_overdue`, which
   * is for a chosen folder that cannot be reached.
   */
  "backup_no_folder",
] as const;

/** The bytes of an event time in a decision's `detail` (`eventAtDetail`): u64 little-endian. */
export const EVENT_AT_DETAIL_BYTES = 8;

/**
 * An event time as a decision's `detail` (D102: a late notification says when the event happened):
 * the wall time it happened, whole milliseconds since 1970-01-01 UTC, rounded down, as 8 bytes,
 * u64 little-endian. `late_report_sirens` carries it always, an `alarm` raised at a start for a
 * countdown that ended before the stop carries it, and a notification raised from either (or from
 * `late_report_notification`, whose value is the opening's time) carries it in its own `detail`.
 * A time before 1970, or one that is not a finite number, is written as 0; it never throws.
 */
export function eventAtDetail(wallMs: number): Uint8Array {
  const detail = new Uint8Array(EVENT_AT_DETAIL_BYTES);
  const floored = Math.floor(wallMs);
  const whole = Number.isSafeInteger(floored) && floored > 0 ? floored : 0;
  new DataView(detail.buffer).setBigUint64(0, BigInt(whole), true);
  return detail;
}

/** The event time `eventAtDetail` wrote, or undefined for any other detail (none, or not 8 bytes). */
export function eventAtOf(detail: Uint8Array | null | undefined): number | undefined {
  if (detail?.length !== EVENT_AT_DETAIL_BYTES) return undefined;
  const value = new DataView(detail.buffer, detail.byteOffset, detail.byteLength).getBigUint64(
    0,
    true,
  );
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

/**
 * The decisions the three designs of the joint step 0 add (docs/m3-m4-plan.md), kept as their own
 * list so `DECISION_KINDS` stays the list whose words the app holds today: the app's owner (P5)
 * adds their words and moves its test to `ALL_DECISION_KINDS`. Every one is snake case and new.
 * Each kind's `value` and `detail` are as its design's table gives them.
 */
export const M3M4_DECISION_KINDS = [
  // docs/m4-design.md sections 4, 5 and 6 (the relay module and upkeep).
  /** relay: a phone registered its push target and key (`push.register`), written now. value: the client. */
  "push_registered",
  /** relay: a phone removed its target (`push.unregister`, or its client removed), written now. */
  "push_unregistered",
  /** relay: the push service answered `badToken`: the target is marked invalid, written now. */
  "push_target_invalid",
  /** upkeep: a relay offered a hub release, once per version; notified in `updates` (D75). */
  "update_offered",
  // docs/m3-updates-design.md section 4 (the firmware module); every name starts `firmware_` or
  // `rollout_`, apart from M2's `update_*` for the hub's own updates.
  /** value: the image's row id. */
  "firmware_added",
  "firmware_removed",
  /** value: the rollout. */
  "rollout_started",
  "rollout_resumed",
  "rollout_done",
  "rollout_cancelled",
  /** A warning. value: the rollout; detail: the device and the reason. */
  "rollout_paused",
  /** The relay offered a firmware release (M4). value: the version (major << 16 | minor << 8 | patch). */
  "firmware_release_offered",
  /** A hold began or changed. value: `device_updates.held`'s code. */
  "firmware_held",
  /** value: the method (`device_updates.method`). */
  "firmware_device_offered",
  /** A Bluetooth session key handed to a phone; detail: the client. */
  "firmware_session_opened",
  /** value: the version, as `firmware_release_offered`. */
  "firmware_verified",
  "firmware_installing",
  "firmware_on_trial",
  "firmware_confirmed",
  /** A warning. value: the device's reason (Update status's reason byte; 18 for the hub's `noContact`). */
  "firmware_refused",
  /** A warning. value: the failed version. */
  "firmware_rolled_back",
  /** D91's reminder. value: days armed. */
  "firmware_reminder",
  // docs/m3-updates-design.md section 7 (the key change after a restore, D141).
  /** A Key change (0x84) sent under a device's old key. */
  "key_change_sent",
  /** A device's first packet under its new key: it switched. */
  "key_changed",
  // The firmware bench's `HubAction`s that come from packet records, as `reply`, `transmit_result`
  // and `too_late` do (hub-design section 11, `benchActions`): never written as decision rows.
  /** From a sent Update offer's `tx` row (0x83). */
  "firmware_offer",
  /** From a received Update query's `rx` row (0x06). */
  "firmware_query",
  /** From a received Update status's `rx` row (0x07). */
  "firmware_status",
  /** From an `rx` row flagged `oldKey` (D141): a packet under the old key, never acted on. */
  "old_key_packet",
] as const;

/**
 * The kinds of `M3M4_DECISION_KINDS` that are only the bench's names for packet records
 * (`benchActions`): no decision row is ever written with one, so the app needs no words for them.
 */
export const PACKET_BENCH_ACTIONS = [
  "firmware_offer",
  "firmware_query",
  "firmware_status",
  "old_key_packet",
] as const satisfies readonly (typeof M3M4_DECISION_KINDS)[number][];

/** One kind of decision (section 6, `decisions.kind`), of M2 or of the joint step 0. */
export type DecisionKind = (typeof DECISION_KINDS)[number] | (typeof M3M4_DECISION_KINDS)[number];

/** Every decision kind: M2's, then the joint step 0's. */
export const ALL_DECISION_KINDS: readonly DecisionKind[] = [
  ...DECISION_KINDS,
  ...M3M4_DECISION_KINDS,
];

/**
 * The hub events M2 adds (`hub_events.code`, HD 6): the level each is recorded at, and its class.
 * Sessions are one `client_sessions` per client per day (section 4, corrected in wave 3; its
 * detail `{client, sessions, firstMs, lastMs}`), not a row per session; a backup's result is
 * `backup_written` or, each failed try, `backup_failed` (section 9); the shell's warnings
 * (`shellWarning`) and a refused update. Every one is routine.
 */
export const M2_HUB_EVENTS = {
  client_sessions: { level: "info", durability: "routine" },
  backup_written: { level: "info", durability: "routine" },
  backup_failed: { level: "warning", durability: "routine" },
  /** The data folder was open when the hub started (section 9, A11): a warning from the shell. */
  data_folder_was_open: { level: "warning", durability: "routine" },
  /** The computer may sleep: the hub could not hold it awake (section 9, wave 3; A8, A11). */
  sleep_not_prevented: { level: "warning", durability: "routine" },
  /** The hub runs a version newer than the package's (section 9, "The privilege boundary"; A8). */
  package_behind: { level: "warning", durability: "routine" },
  /** A top folder's list is open and the service cannot close it (section 9, "The top folders"; A11). */
  data_folder_open: { level: "warning", durability: "routine" },
  /** A top folder's deny entries name the hub's own accounts: accepted, warned of (A11). */
  data_folder_denies: { level: "warning", durability: "routine" },
  /**
   * A restore is waiting and could not be put in place (section 9, "A swap that did not happen"):
   * critical, written now, and a notification (A6's table).
   */
  restore_waiting: { level: "critical", durability: "now" },
  /** An update refused (section 9): its reason in the detail. */
  update_refused: { level: "warning", durability: "routine" },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly level: "info" | "warning" | "critical";
      readonly durability: "routine" | "now";
    }
  >
>;

/** One of M2's hub event codes. */
export type M2HubEventCode = keyof typeof M2_HUB_EVENTS;

/**
 * The hub events the joint step 0 adds (docs/m4-design.md section 4; docs/m3-updates-design.md
 * section 4): the level and class of each, as `M2_HUB_EVENTS`. Kept apart for the same reason as
 * `M3M4_DECISION_KINDS`.
 */
export const M3M4_HUB_EVENTS = {
  /** One per hour in which the relay link went up or down: detail `{ups, downs, longestDownMs}`. */
  relay_link: { level: "info", durability: "routine" },
  /**
   * The relay unreachable for 180 s ‡, once per outage: notified to manage system and the console
   * in `hub`, to open sessions only (never pushed).
   */
  relay_unreachable: { level: "warning", durability: "now" },
  /** The relay reachable again after `relay_unreachable`. */
  relay_reachable: { level: "info", durability: "routine" },
  /** The link was replaced by another computer with this hub's key (close 4001 `replaced`). */
  relay_identity_in_use: { level: "warning", durability: "now" },
  /** An outbox row older than 7 days ‡ dropped unsent. */
  push_dropped: { level: "info", durability: "routine" },
  /** A firmware file refused: `badFile`, `badSignature`, `wrongTarget`, `tooLarge`, `storeFull`. */
  firmware_file_refused: { level: "warning", durability: "routine" },
  /** An indexed image's file missing or wrong at start. */
  firmware_store_damaged: { level: "critical", durability: "now" },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly level: "info" | "warning" | "critical";
      readonly durability: "routine" | "now";
    }
  >
>;

/** One of the joint step 0's hub event codes. */
export type M3M4HubEventCode = keyof typeof M3M4_HUB_EVENTS;
