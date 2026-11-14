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
  /** A late report: the countdown had ended; sirens sound for what is left. value: seconds (D106). */
  "late_report_sirens",
  /** A report so late even the sirens' time has passed. value: the opening's wall time, whole seconds since 1970 UTC. */
  "late_report_notification",
  /** A door report while disarmed or waiting: recorded only (AL2b). */
  "report_while_disarmed",
  /** An alarm started: a countdown ended while armed, or a zero countdown (critical). */
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
  "permissions_changed",
  "user_management_changed",
  /** health (section 7): low battery at 10% or below, cleared above 15% (HB33). */
  "battery_low",
  "battery_ok",
  /** health: cover tamper (D9). */
  "tamper_opened",
  "tamper_closed",
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
] as const;

/** One kind of decision (section 6, `decisions.kind`). */
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * The hub events M2 adds (`hub_events.code`, HD 6): the level each is recorded at, and its class.
 * Sessions are `client_connected` and `client_closed` (section 4); a backup's result is
 * `backup_written` or, each failed try, `backup_failed` (section 9). Every one is routine.
 */
export const M2_HUB_EVENTS = {
  client_connected: { level: "info", durability: "routine" },
  client_closed: { level: "info", durability: "routine" },
  backup_written: { level: "info", durability: "routine" },
  backup_failed: { level: "warning", durability: "routine" },
} as const satisfies Readonly<
  Record<string, { readonly level: "info" | "warning"; readonly durability: "routine" }>
>;

/** One of M2's hub event codes. */
export type M2HubEventCode = keyof typeof M2_HUB_EVENTS;
