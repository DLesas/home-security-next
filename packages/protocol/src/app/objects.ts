/**
 * The objects the app channel's replies and events carry (docs/m2-design.md sections 6 and 7):
 * a group, a mode, a schedule entry, a person, a client, a device, a notification, the snapshot.
 * Their fields follow sections 4, 6 and 7.
 */
import { z } from "zod";
import { recordJson } from "../records.ts";
import {
  clientKind,
  clientRef,
  dataRateValue,
  deviceNameValue,
  deviceRef,
  displayName,
  groupRef,
  liveRevision,
  bootValue,
  localDateText,
  localTimeText,
  modeRef,
  personRef,
  recordSeqValue,
  revision,
  roleValue,
  scheduleRef,
  siteChannelValue,
  wallMs,
  weekdayList,
} from "./values.ts";

/** A group's sirens: every siren (the default, AL2a), or a list. */
export const sirenChoice = z.union([z.literal("all"), z.array(deviceRef).readonly()]);

/** A group (section 7): a set of sensors and a choice of sirens. */
export const groupObject = z
  .strictObject({
    id: groupRef,
    name: displayName,
    sensors: z.array(deviceRef).readonly(),
    sirens: sirenChoice,
    revision,
  })
  .readonly();

/** A mode (section 7); `fixed` is `away` or `disarmed` for the two of D90, which cannot be edited. */
export const modeObject = z
  .strictObject({
    id: modeRef,
    name: displayName,
    fixed: z.enum(["no", "away", "disarmed"]),
    groups: z.array(groupRef).readonly(),
    revision,
  })
  .readonly();

/** What a schedule entry does (section 7): switch to a mode, or arm or disarm a group or sensor. */
export const scheduleAction = z.enum(["switchMode", "arm", "disarm"]);

/** What a schedule entry names: a mode for `switchMode`, a group or a sensor for the others. */
export const scheduleTarget = z.union([
  z.strictObject({ mode: modeRef }).readonly(),
  z.strictObject({ group: groupRef }).readonly(),
  z.strictObject({ sensor: deviceRef }).readonly(),
]);

/** On which days: chosen weekdays, every day, or once on a date (section 6). */
export const scheduleDays = z.union([
  weekdayList,
  z.literal("everyDay"),
  z.strictObject({ date: localDateText }).readonly(),
]);

/** A schedule entry with its next time (section 6). */
export const scheduleObject = z
  .strictObject({
    id: scheduleRef,
    name: displayName,
    action: scheduleAction,
    target: scheduleTarget,
    at: localTimeText,
    days: scheduleDays,
    enabled: z.boolean(),
    /** The next run, wall milliseconds, or null while none is due (disabled, past, clock untrusted). */
    nextMs: wallMs.nullable(),
    /** The last time it was missed (D116), shown until it next runs. */
    missed: z
      .strictObject({
        dueMs: wallMs,
        why: z.enum(["hubOff", "clockNotSet"]),
        count: z.int().min(1),
      })
      .readonly()
      .nullable(),
    revision,
  })
  .readonly();

/** A person's permissions on one device (D33): manage includes view ‡. */
export const devicePermission = z
  .strictObject({ device: deviceRef, manage: z.boolean(), view: z.boolean() })
  .readonly();

/** A person (section 7) with their global permissions. */
export const personObject = z
  .strictObject({
    id: personRef,
    name: displayName,
    manageUsers: z.boolean(),
    manageSystem: z.boolean(),
    devices: z.array(devicePermission).readonly(),
    revision,
  })
  .readonly();

/** A linked client (section 7). */
export const clientObject = z
  .strictObject({
    id: clientRef,
    person: personRef.nullable(),
    kind: clientKind,
    name: displayName,
    createdMs: wallMs,
    lastSeenMs: wallMs.nullable(),
    /** The client whose token linked this one, or null for the console and the installer. */
    linkedBy: clientRef.nullable(),
  })
  .readonly();

/** A sensor's arming as the app shows it (HD 8's four states, the waiting ones together). */
export const sensorArm = z.enum(["disarmed", "armed", "waitsForDoorToClose"]);

/** A door's last known state. */
export const doorState = z.enum(["unknown", "open", "closed"]);

/** A device's health, as the device screens show it (section 7, "Device health"). */
export const deviceHealth = z
  .strictObject({
    silent: z.boolean(),
    batteryLow: z.boolean(),
    tamperOpen: z.boolean(),
    poorLink: z.boolean(),
  })
  .readonly();

/** A device in lists and snapshots (section 6, `device.list`, `snapshot`). */
export const deviceObject = z
  .strictObject({
    id: deviceRef,
    name: deviceNameValue,
    role: roleValue,
    state: z.enum(["provisioning", "paired", "contacted", "resetByOwner", "removed", "leftBehind"]),
    firmware: z.string(),
    batteryPercent: z.int().min(0).max(100).nullable(),
    signal: z.strictObject({ rssiDbm: z.int(), snrQuarterDb: z.int() }).readonly().nullable(),
    temperatureC: z.int().nullable(),
    lastSeenMs: wallMs.nullable(),
    /** The gateway that heard it last (AP4). */
    heardBy: deviceRef.nullable(),
    health: deviceHealth,
  })
  .readonly();

/** A sensor in a snapshot. */
export const sensorStatus = z
  .strictObject({
    id: deviceRef,
    arm: sensorArm,
    door: doorState,
    countdownSecondsLeft: z.int().min(0).nullable(),
  })
  .readonly();

/** What a siren should do, was commanded, reports (as `hsn status`, HD 9). */
const sirenOutput = z
  .strictObject({ kind: z.enum(["off", "sound", "test"]), secondsLeft: z.int().min(0).nullable() })
  .readonly();

export const sirenStatus = z
  .strictObject({
    id: deviceRef,
    should: sirenOutput,
    commanded: sirenOutput.nullable(),
    reported: sirenOutput.nullable(),
    wifi: z.enum(["up", "lost", "unknown"]),
    lora: z.enum(["up", "lost", "unknown"]),
  })
  .readonly();

export const gatewayStatus = z
  .strictObject({
    id: deviceRef,
    session: z.boolean(),
    offline: z.boolean(),
    lastStatusMs: wallMs.nullable(),
  })
  .readonly();

/** The alarm while it runs (D95). */
export const alarmStatus = z
  .strictObject({
    startedMs: wallMs,
    triggers: z.array(deviceRef).readonly(),
    sirens: z.array(deviceRef).readonly(),
  })
  .readonly();

/** The site's settings an app may see (section 6, `site.show`): never the Wi-Fi password. */
export const siteObject = z
  .strictObject({
    channel: siteChannelValue,
    rate: dataRateValue,
    countdownS: z.int().min(0).max(255),
    autoStopS: z.int().min(1),
    wifiName: z.string(),
    retentionRoutineDays: z.int().min(1),
    retentionEventDays: z.int().min(1),
  })
  .readonly();

/** The site move's stage (D115), as `hsn site change status`. */
export const siteMoveStatus = z
  .strictObject({
    stage: z.enum(["announcing", "switched", "done", "cancelled"]),
    channel: siteChannelValue.nullable(),
    rate: dataRateValue.nullable(),
    confirmed: z.int().min(0),
    total: z.int().min(0),
  })
  .readonly();

/**
 * The notification categories a client may turn off (section 7, "The categories' names"), in the
 * order of their bits in `notification_prefs.categories`, bit 0 first. A new optional category
 * takes the next bit, never an old one.
 */
export const OPTIONAL_CATEGORIES = [
  "sensorSilentWhileDisarmed",
  "sirenPathLost",
  "gatewayOffline",
  "batteryLow",
  "armDisarm",
  "updates",
] as const;
export const optionalCategory = z.enum(OPTIONAL_CATEGORIES);

/** A category's bit in `notification_prefs.categories`. */
export function categoryBit(category: (typeof OPTIONAL_CATEGORIES)[number]): number {
  return 1 << OPTIONAL_CATEGORIES.indexOf(category);
}

/** Every category: the optional ones, then those always delivered. */
export const NOTIFICATION_CATEGORIES = [
  ...OPTIONAL_CATEGORIES,
  "countdown",
  "alarm",
  "localAlarm",
  "tamper",
  "longPress",
  "sensorSilentWhileArmed",
  "sirenSilent",
  "jamming",
  "scheduleMissedOrHeldBack",
  "disk",
  "newClient",
  "backup",
  "hub",
] as const;
export const notificationCategory = z.enum(NOTIFICATION_CATEGORIES);

/** A notification (section 7), as `notifications.list` and the `notification` event carry it. */
export const notificationObject = z
  .strictObject({
    /** Its record's sequence number (`notifications.seq`). */
    seq: recordSeqValue,
    atMs: wallMs,
    clockOk: z.boolean(),
    kind: z.string(),
    category: notificationCategory,
    critical: z.boolean(),
    device: deviceRef.nullable(),
    /** The record that caused it (`cause_seq`). */
    cause: recordSeqValue.nullable(),
    read: z.boolean(),
    /** Raised more than 60 s ‡ before it was delivered (D102's rule). */
    delayed: z.boolean(),
  })
  .readonly();

/** The current mode (D90), and whether arming changed since the last switch. */
export const currentMode = z
  .strictObject({ mode: modeRef.nullable(), modified: z.boolean() })
  .readonly();

/** `hub.info` (section 6). */
export const hubInfo = z
  .strictObject({
    hub: z.string(),
    proto: z.int().min(1),
    identity: z.string(),
    fingerprint: z.string(),
    timeZone: z.string(),
    clockTrusted: z.boolean(),
    boot: bootValue,
  })
  .readonly();

/** `snapshot` (section 6): the state the person may see, at revision `rev`. */
export const snapshotObject = z
  .strictObject({
    rev: liveRevision,
    hub: hubInfo,
    site: siteObject,
    mode: currentMode,
    devices: z.array(deviceObject).readonly(),
    sensors: z.array(sensorStatus).readonly(),
    sirens: z.array(sirenStatus).readonly(),
    gateways: z.array(gatewayStatus).readonly(),
    alarm: alarmStatus.nullable(),
    siteMove: siteMoveStatus.nullable(),
    notifications: z.array(notificationObject).readonly(),
  })
  .readonly();

/** The live topics a session may subscribe to (section 6, `subscribe`). */
export const TOPICS = [
  "arming",
  "devices",
  "alarm",
  "notifications",
  "history",
  "config",
  "people",
  "hub",
] as const;
export const topic = z.enum(TOPICS);

/** The kinds of record history holds: `recordJson`'s. */
export const historyKind = z.enum([
  "rx",
  "tx",
  "decision",
  "deviceLog",
  "hubEvent",
  "command",
  "reject",
  "notification",
  "notificationRead",
]);

/**
 * One row of history (section 6, `history.query`): `row` as `hsn log --json` writes it, the
 * schema `recordJson` of `@hsn/protocol/records`, of the same kind.
 */
export const historyRow = z
  .strictObject({ kind: historyKind, row: recordJson })
  .refine((r) => r.row.kind === r.kind, "the row is of its kind")
  .readonly();

export type GroupObject = z.infer<typeof groupObject>;
export type ModeObject = z.infer<typeof modeObject>;
export type ScheduleObject = z.infer<typeof scheduleObject>;
export type PersonObject = z.infer<typeof personObject>;
export type ClientObject = z.infer<typeof clientObject>;
export type DeviceObject = z.infer<typeof deviceObject>;
export type NotificationObject = z.infer<typeof notificationObject>;
export type SnapshotObject = z.infer<typeof snapshotObject>;
export type Topic = z.infer<typeof topic>;
export type OptionalCategory = z.infer<typeof optionalCategory>;
export type NotificationCategory = z.infer<typeof notificationCategory>;
export type DisplayNameValue = z.infer<typeof displayName>;
export type ClientKindValue = z.infer<typeof clientKind>;
export type HistoryRow = z.infer<typeof historyRow>;
export type LocalTimeText = z.infer<typeof localTimeText>;
export type ScheduleDays = z.infer<typeof scheduleDays>;
export type SirenChoice = z.infer<typeof sirenChoice>;
export type HubInfo = z.infer<typeof hubInfo>;
