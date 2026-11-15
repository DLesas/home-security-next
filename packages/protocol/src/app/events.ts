/**
 * The app channel's events (docs/m2-design.md section 6, the events table), each to the
 * sessions whose person may see what it names (section 5, "Live updates").
 */
import { z } from "zod";
import {
  alarmStatus,
  clientObject,
  currentMode,
  deviceObject,
  groupObject,
  historyRow,
  modeObject,
  notificationObject,
  personObject,
  scheduleObject,
  sensorArm,
  siteMoveStatus,
  siteObject,
  sirenStatus,
} from "./objects.ts";
import { fileChunkBody } from "./ops.ts";
import { deviceRef, jobRef, wallMs } from "./values.ts";

/** What a `health` event names (section 6): silence, a path, offline, interference, battery, tamper. */
export const healthWhat = z.enum([
  "silent",
  "heard",
  "pathLost",
  "pathBack",
  "offline",
  "online",
  "interference",
  "interferenceEnded",
  "batteryLow",
  "batteryOk",
  "tamperOpen",
  "tamperClosed",
]);

/** The events, by name, with their bodies. */
/** Why a download stopped short (section 6): the file could not be made, or the hub is stopping. */
export const FILE_FAILED_REASONS = ["io", "stopping"] as const;

export const APP_EVENTS = {
  arming: z
    .strictObject({
      sensors: z.array(z.strictObject({ sensor: deviceRef, arm: sensorArm }).readonly()).readonly(),
      mode: currentMode,
    })
    .readonly(),
  countdown: z
    .strictObject({
      sensor: deviceRef,
      what: z.enum(["started", "continued", "cancelled", "ended"]),
      secondsLeft: z.int().min(0),
      /** The record that started it. */
      trigger: z.int().min(0).nullable(),
    })
    .readonly(),
  alarm: z
    .strictObject({
      what: z.enum(["started", "triggerAdded", "siren", "ended"]),
      alarm: alarmStatus.nullable(),
      sirens: z.array(sirenStatus).readonly(),
      ended: z.enum(["disarmed", "byItself"]).nullable(),
    })
    .readonly(),
  door: z.strictObject({ sensor: deviceRef, open: z.boolean(), atMs: wallMs }).readonly(),
  reading: z
    .strictObject({
      device: deviceRef,
      batteryPercent: z.int().min(0).max(100).nullable(),
      signal: z.strictObject({ rssiDbm: z.int(), snrQuarterDb: z.int() }).readonly().nullable(),
      temperatureC: z.int().nullable(),
    })
    .readonly(),
  health: z.strictObject({ device: deviceRef, what: healthWhat, sinceMs: wallMs }).readonly(),
  device: z
    .strictObject({ what: z.enum(["added", "removed", "renamed", "state"]), device: deviceObject })
    .readonly(),
  notification: notificationObject,
  record: historyRow,
  config: z.union([
    z.strictObject({ group: groupObject }).readonly(),
    z.strictObject({ groupDeleted: z.int().min(1) }).readonly(),
    z.strictObject({ mode: modeObject }).readonly(),
    z.strictObject({ modeDeleted: z.int().min(1) }).readonly(),
    z.strictObject({ schedule: scheduleObject }).readonly(),
    z.strictObject({ scheduleDeleted: z.int().min(1) }).readonly(),
    z.strictObject({ site: siteObject }).readonly(),
  ]),
  people: z.union([
    z.strictObject({ person: personObject }).readonly(),
    z.strictObject({ personRemoved: z.int().min(1) }).readonly(),
    z.strictObject({ client: clientObject }).readonly(),
    z.strictObject({ clientRemoved: z.int().min(1) }).readonly(),
    z.strictObject({ userManagement: z.boolean() }).readonly(),
  ]),
  site: siteMoveStatus.nullable(),
  /**
   * To people with manage system and the console, by `what` (section 5): `updateStaged`,
   * `updateRefused` (a file refused, or a switch refused for space), `updateSwitching`, `backup`
   * (any backup decision, `backup_written`, `backup_failed`; `detail.kind` names it),
   * `databaseFailing` (the first `commit_failed` of a run), `databaseRecovered` (the first commit
   * after them), `databaseSize` (the size guard's state changing), `historyShortened`. A restore
   * and an update's outcome come before any session: notifications and `update.status` carry them.
   * Sent by `core/app/live.ts`, shown by the app's `state/live.ts` (each has its TODO).
   */
  hub: z
    .strictObject({
      what: z.enum([
        "updateStaged",
        "updateRefused",
        "updateSwitching",
        "backup",
        "databaseFailing",
        "databaseRecovered",
        "databaseSize",
        "historyShortened",
      ]),
      detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    })
    .readonly(),
  session: z.strictObject({}).readonly(),
  ping: z.strictObject({}).readonly(),
  forget: z.strictObject({ device: deviceRef }).readonly(),
  backupKeyChanged: z.strictObject({ epoch: z.int().min(0) }).readonly(),
  /** A file streamed to the client (`backup.export`), as `fileChunk` requests travel the other way. */
  fileChunk: fileChunkBody,
  /**
   * A download that stops before its end mark (section 6): the reply `{job}` came first, then
   * chunks; nothing was saved.
   */
  fileFailed: z.strictObject({ job: jobRef, reason: z.enum(FILE_FAILED_REASONS) }).readonly(),
} as const;

export type AppEventName = keyof typeof APP_EVENTS;
export const APP_EVENT_NAMES = Object.keys(APP_EVENTS) as readonly AppEventName[];
export type AppEventBody<N extends AppEventName> = z.infer<(typeof APP_EVENTS)[N]>;
