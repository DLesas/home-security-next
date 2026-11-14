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
import { deviceRef, wallMs } from "./values.ts";

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
  hub: z
    .strictObject({
      what: z.enum([
        "updateStaged",
        "updateSwitching",
        "backup",
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
} as const;

export type AppEventName = keyof typeof APP_EVENTS;
export const APP_EVENT_NAMES = Object.keys(APP_EVENTS) as readonly AppEventName[];
export type AppEventBody<N extends AppEventName> = z.infer<(typeof APP_EVENTS)[N]>;
