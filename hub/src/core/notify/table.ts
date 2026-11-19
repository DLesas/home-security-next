/**
 * The notification table (m2-design.md section 7, "Notifications"; D46, D69, D75, D76, D82, D92,
 * D97, D109, D114, HB9, HB10, HB33, AP6, AP9a): which record raises a notification, its category,
 * whether it can be turned off, and whether it is critical. Pure.
 *
 * What a record does not name here raises nothing: a door opening while disarmed is recorded
 * only (D46), the per-sensor `armed` and `disarmed` never raise one (an action's notice comes from
 * its summary, `mode_switched` or `arming_changed`), `update_switching` is announced to the
 * apps as a `hub` event instead, and `group_sirens_gone` (D144) is a history record only: the
 * person who caused it was told by the app's dialog, and nobody else is told.
 */
import type { NotificationCategory, OptionalCategory } from "@hsn/protocol/app";
import type { DecisionKind } from "../model/decisions.ts";
import { type DeviceId, deviceId, type PersonId, personId } from "../model/ids.ts";
import { NO_CONTACT_REASON, ROLLED_BACK_REASON } from "../model/rows.ts";

/** What the table makes of one record. */
export interface Classified {
  readonly category: NotificationCategory;
  readonly critical: boolean;
  /** Delivered whatever a client's categories say: a category that cannot be turned off, or D97's case. */
  readonly mandatory: boolean;
  /**
   * For an action's notice and a schedule's warnings: the sensors whose viewers receive it,
   * instead of the viewers of the device the decision names.
   */
  readonly sensors: readonly DeviceId[] | undefined;
  /**
   * To every person with *manage system* whatever device it names: the notices of updates, which
   * only they may act on (D54; m3-updates-design section 4).
   */
  readonly toManageSystem?: boolean;
  /**
   * To exactly these people, whatever device it names or who may arm: a presence offer, which is
   * personal (m3-design section 6).
   */
  readonly people?: readonly PersonId[];
}

/** What the table needs to know of the house when it decides. */
export interface Facts {
  /** The sensor is armed as the user sees it (both waiting states count, HD 8). */
  readonly armed: (sensor: DeviceId) => boolean;
  /** Any sensor is armed. */
  readonly anyArmed: boolean;
  /** The sensors a switch to this mode changes, as `layout` resolves it before `alarm` acts. */
  readonly switchChanges: (mode: number) => readonly DeviceId[];
}

/** The categories a client may turn off (`OPTIONAL_CATEGORIES`). */
const OPTIONAL: ReadonlySet<NotificationCategory> = new Set<OptionalCategory>([
  "sensorSilentWhileDisarmed",
  "sirenPathLost",
  "gatewayOffline",
  "batteryLow",
  "armDisarm",
  "updates",
]);

export function isOptionalCategory(category: NotificationCategory): boolean {
  return OPTIONAL.has(category);
}

function row(
  category: NotificationCategory,
  critical: boolean,
  sensors?: readonly DeviceId[],
): Classified {
  return { category, critical, mandatory: !OPTIONAL.has(category), sensors };
}

/** The decisions of the table, and what each raises. */
export function classifyDecision(
  kind: DecisionKind,
  device: DeviceId | null,
  value: number | null,
  detail: Uint8Array | null,
  facts: Facts,
): Classified | undefined {
  const armed = device !== null && facts.armed(device);
  switch (kind) {
    // Countdown and alarm: cannot be turned off (D75), critical (D92).
    case "countdown_started":
      return row("countdown", true);
    case "alarm":
    case "late_report_sirens":
    case "late_report_notification":
      return row("alarm", true);
    case "local_alarm_reported":
      return row("localAlarm", false);
    // Cover tamper (D9): cannot be turned off (D75), critical while the sensor is armed ‡.
    case "tamper_opened":
      return row("tamper", armed);
    case "long_press_ignored":
      return row("longPress", false);
    // Silence (HB9): while armed, cannot be turned off and critical; while disarmed, optional.
    case "sensor_silent":
      return armed ? row("sensorSilentWhileArmed", true) : row("sensorSilentWhileDisarmed", false);
    // Critical while any sensor is armed: the decision's value 1 (HD 8).
    case "siren_silent":
      return row("sirenSilent", value === 1);
    case "siren_wifi_lost":
    case "siren_lora_lost":
      return row("sirenPathLost", false);
    // D97: cannot be turned off while any sensor only that gateway hears is armed.
    case "gateway_offline": {
      const forced = soleSensors(detail).some((sensor) => facts.armed(sensor));
      return { ...row("gatewayOffline", false), mandatory: forced };
    }
    // Jamming (D82): cannot be turned off, critical while armed (any sensor, HD 8).
    case "interference_started":
    case "noise_interference_started":
    case "interference_learned_as_normal":
      return row("jamming", facts.anyArmed);
    case "battery_low":
      return row("batteryLow", false);
    // One per action, from its summary: recipients the viewers of any sensor it changes.
    case "mode_switched":
      return row("armDisarm", false, value === null ? [] : facts.switchChanges(value));
    case "arming_changed":
      return row("armDisarm", false, soleSensors(detail));
    // A schedule's warnings, beside its arming's own notice (AL7, AL12).
    case "schedule_ran": {
      const warned = scheduleWarnings(detail);
      return warned.length === 0 ? undefined : row("armDisarm", false, warned);
    }
    // A heartbeat's unexpected door or cover (D114): the door's critical while its sensor is armed.
    case "door_state_unexpected":
      return row("stateUnexpected", armed);
    case "cover_state_unexpected":
      return row("stateUnexpected", false);
    // Presence offers (m3-design section 6, F16; H1's rule in `app/presence.ts`): arming and
    // disarming's category, which can be turned off (D75), never critical, to exactly the people
    // the decision's detail names. Pushed with their one action (`armAway`, `disarm`) by `relay`.
    case "presence_offer_away":
    case "presence_offer_disarm":
      return { ...row("armDisarm", false), people: namedPeople(detail) };
    case "schedules_waiting_for_clock":
    case "schedule_missed":
    case "schedule_held_back":
      return row("scheduleMissedOrHeldBack", false);
    case "update_staged":
    case "update_healthy":
      return row("updates", false);
    // Releases offered and firmware rollouts (docs/m4-design.md sections 6 and 9;
    // m3-updates-design section 4): `updates`, which can be turned off (D75), never critical, to
    // manage system whatever device it names. A hub release offered, a firmware release offered, a
    // device's update refused (`noContact` and an install that did not take included) or rolled
    // back, and D91's reminder for a sensor held armed.
    case "update_offered":
    case "firmware_release_offered":
    case "firmware_refused":
    case "firmware_rolled_back":
    case "firmware_reminder":
      return UPDATES;
    // A rollout paused: told only when the hub paused it and no notice of its own says so already
    // (`pauseTold`).
    case "rollout_paused":
      return pauseTold(detail) ? UPDATES : undefined;
    case "update_rolled_back":
    case "restored":
      return row("hub", false);
    // Backups (section 9): to manage system, cannot be turned off ‡, never critical. Each is
    // raised once by `upkeep` (`backup_no_folder` with no folder chosen, `backup_overdue` once per
    // episode for a chosen folder that cannot be reached); every one raised is told.
    case "backup_no_folder":
    case "backup_overdue":
    case "backup_key_replaced":
    case "backup_folder_on_data_disk":
      return row("backup", false);
    default:
      return undefined;
  }
}

/**
 * The hub events of the table: the disk's (section 7), a restore waiting (section 9), the relay
 * unreachable (M4) and the firmware store damaged (M3).
 */
export function classifyHubEvent(code: string): Classified | undefined {
  switch (code) {
    case "commit_failed":
    case "history_shortened":
      return row("disk", false);
    // A restore the phone was told succeeded and that could not be put in place (section 9, "A
    // swap that did not happen"): critical, the hub itself as a restore done is, so `hub`, to
    // manage system, not to be turned off. Critical, so told at every start that raises it.
    case "restore_waiting":
      return row("hub", true);
    // The relay unreachable for 180 s ‡, once per outage (docs/m4-design.md sections 4 and 9): the
    // hub itself, to manage system and the console, not to be turned off, never critical. Told to
    // open sessions only: the relay module never pushes it (`NEVER_PUSHED`), since pushes cannot
    // leave.
    case "relay_unreachable":
      return row("hub", false);
    // An indexed firmware image's file missing or damaged at a start (m3-updates-design section 4):
    // critical, as `restore_waiting` is, so `hub`, to manage system, not to be turned off, written
    // now, and told at every start that raises it.
    case "firmware_store_damaged":
      return row("hub", true);
    default:
      return undefined;
  }
}

/** The firmware notices: `updates`, to manage system whatever device they name. */
const UPDATES: Classified = { ...row("updates", false), toManageSystem: true };

/**
 * Whether a `rollout_paused` is told (one notice per event): from its own record, never from what
 * came before it in the step. Its `detail`, as `firmware` lays it out (`pausedDetail`), is the
 * device u32 LE (0 when none caused it) and the reason u8, and none when a person paused it.
 *
 * - A person's pause (no detail): not told; they did it.
 * - Paused by a device's refusal (a device named, reasons 1 to 17, and 18 `noContact`): not told;
 *   `firmware_refused` is the notice, raised with it (an install that did not take is refused
 *   `imageCheck`, and no contact is refused `noContact`, so both are here).
 * - Paused by a rollback (`ROLLED_BACK_REASON`): not told; `firmware_rolled_back` is the notice.
 * - Paused because the store's copy is damaged (no device, the reason `hashMismatch`): not told;
 *   the critical `firmware_store_damaged` is the notice.
 * - Every other pause the hub makes is told: a pilot failed in its soak (`PILOT_FAILED_REASON`), and
 *   any reason not known here.
 */
export function pauseTold(detail: Uint8Array | null): boolean {
  if (detail === null) return false;
  if (detail.byteLength !== PAUSED_DETAIL_BYTES) return true;
  const view = new DataView(detail.buffer, detail.byteOffset, detail.byteLength);
  const reason = view.getUint8(4);
  if (reason === ROLLED_BACK_REASON) return false;
  // A device's refusal, or the store's damage (no device): each has its own notice.
  return !(reason >= 1 && reason <= NO_CONTACT_REASON);
}

/** `rollout_paused`'s detail: the device u32 LE and the reason u8. */
const PAUSED_DETAIL_BYTES = 5;

/** A new client linked to a person (section 7, "People and permissions"): cannot be turned off ‡. */
export const NEW_CLIENT: Classified = row("newClient", false);

/** Device numbers, u32 LE each (HD 6: `gateway_offline`'s detail; `arming_changed`'s sensors). */
export function soleSensors(detail: Uint8Array | null): readonly DeviceId[] {
  if (detail === null) return [];
  const view = new DataView(detail.buffer, detail.byteOffset, detail.byteLength);
  const sensors: DeviceId[] = [];
  for (let at = 0; at + 4 <= detail.byteLength; at += 4) {
    sensors.push(deviceId(view.getUint32(at, true)));
  }
  return sensors;
}

/** Person ids, u32 LE each: a presence offer's detail, the people it is for. */
export function namedPeople(detail: Uint8Array | null): readonly PersonId[] {
  if (detail === null) return [];
  const view = new DataView(detail.buffer, detail.byteOffset, detail.byteLength);
  const people: PersonId[] = [];
  for (let at = 0; at + 4 <= detail.byteLength; at += 4) {
    people.push(personId(view.getUint32(at, true)));
  }
  return people;
}

/**
 * The sensors a schedule's run left waiting for their door or armed with a low battery, from
 * `schedule_ran`'s detail as `schedules` lays it out: the action and the outcome (u8 each), then
 * four device lists, armed, disarmed, waiting, low, each a u16 LE count and u32 LE devices.
 */
export function scheduleWarnings(detail: Uint8Array | null): readonly DeviceId[] {
  if (detail === null) return [];
  const view = new DataView(detail.buffer, detail.byteOffset, detail.byteLength);
  const lists: DeviceId[][] = [];
  let at = 2;
  for (let list = 0; list < 4; list++) {
    if (at + 2 > detail.byteLength) return [];
    const count = view.getUint16(at, true);
    at += 2;
    if (at + 4 * count > detail.byteLength) return [];
    const devices: DeviceId[] = [];
    for (let i = 0; i < count; i++) devices.push(deviceId(view.getUint32(at + 4 * i, true)));
    at += 4 * count;
    lists.push(devices);
  }
  return [...new Set([...(lists[2] ?? []), ...(lists[3] ?? [])])];
}

/**
 * No flood (section 7): a notification is not raised when one of the same kind about the same
 * device (or, naming no device, about the hub) was raised in the last 10 minutes ‡, unless it is
 * critical or its category is one of these.
 */
export function floodExempt(classified: Classified): boolean {
  const { category } = classified;
  return (
    classified.critical ||
    category === "armDisarm" ||
    category === "scheduleMissedOrHeldBack" ||
    category === "newClient" ||
    category === "hub"
  );
}
