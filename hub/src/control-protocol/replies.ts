/**
 * The answer to every command of section 9 (hub-design.md), as the core's control module
 * makes it in a `respond` effect and the CLI checks it. A success carries a result of the
 * command's own kind; a failure carries an error the CLI shows.
 */
import { appError } from "@hsn/protocol/app";
import { z } from "zod";
import { recordJson } from "./records.ts";
import { dataRate, deviceName, hexBytes, roleName, siteChannel, time, unsigned } from "./values.ts";

const names = z.array(deviceName).readonly();
const nullableTime = time.nullable();

/** A sensor's arming as the user sees it: both waiting states count as armed (section 8). */
const armShown = z.enum(["disarmed", "armed", "waitsForDoorToClose"]);
const doorShown = z.enum(["open", "closed", "unknown"]);
const pathShown = z.enum(["up", "lost", "none"]);

/** What a siren should do, was last commanded, or last reported (section 8). */
const sirenActivity = z
  .object({
    kind: z.enum(["off", "sounding", "testing"]),
    secondsLeft: z.int().min(0).nullable(),
  })
  .readonly();

const statusResult = z
  .object({
    kind: z.literal("status"),
    sensors: z
      .array(
        z
          .object({
            name: deviceName,
            arm: armShown,
            door: doorShown,
            countdownSecondsLeft: z.int().min(0).nullable(),
          })
          .readonly(),
      )
      .readonly(),
    alarm: z.object({ startedMs: time, triggers: names, sirens: names }).readonly().nullable(),
    sirens: z
      .array(
        z
          .object({
            name: deviceName,
            should: sirenActivity,
            commanded: sirenActivity.nullable(),
            reported: sirenActivity.nullable(),
            wifi: pathShown,
            lora: pathShown,
          })
          .readonly(),
      )
      .readonly(),
    gateways: z
      .array(
        z
          .object({
            name: deviceName,
            session: z.boolean(),
            /** The link's label, when connected. */
            link: z.string().nullable(),
            lastStatusMs: nullableTime,
            noiseMedianDbm: z.int().nullable(),
            baselineDbm: z.number().nullable(),
          })
          .readonly(),
      )
      .readonly(),
    /**
     * SPEC-QUESTION: section 9 shows the last commit and the staged items, which the writer
     * knows and the core does not; the shell fills these in on the core's answer.
     */
    lastCommitMs: nullableTime,
    stagedItems: z.int().min(0),
    /** The database's pages in use, in bytes; null before the first commit (section 6). */
    databaseBytes: z.int().min(0).nullable(),
    /** Whether the size guard is shortening history to stay within the disk limit. */
    historyShortened: z.boolean(),
    /**
     * The longest turn of the loop since the hub started or since the last `hsn status`, in
     * milliseconds (section 3's limit per turn): the shell fills it in, and reading it starts
     * the count again. Always 0 under lockstep, so runs never differ by it.
     */
    longestTurnMs: z.number().min(0),
  })
  .readonly();

const deviceState = z.enum([
  "provisioning",
  "paired",
  "contacted",
  "reset",
  "removed",
  /** Left behind by a forced site move: must be paired again (D115). */
  "leftBehind",
]);

const deviceSummary = z
  .object({
    name: deviceName,
    role: roleName,
    address: unsigned(32),
    state: deviceState,
    /** "major.minor.patch", when known. */
    firmware: z.string().nullable(),
    lastSeenMs: nullableTime,
  })
  .readonly();

/** A device's settings as the hub holds them, by role (§6). */
const deviceSettings = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("sensor"),
      version: unsigned(8),
      countdownS: unsigned(8),
      heartbeatUnits: unsigned(8),
      linkCheckEvery: unsigned(8),
      sendRate: dataRate,
      replyRate: dataRate,
      replyRateFixed: z.boolean(),
      correctionUnits: z.int(),
      correctionFixed: z.boolean(),
    })
    .readonly(),
  z
    .object({
      role: z.literal("siren"),
      version: unsigned(8),
      wifiIntervalS: unsigned(8),
      loraCheckUnits: unsigned(8),
      maxSoundS: unsigned(16),
      sendRate: dataRate,
      commandRate: dataRate,
    })
    .readonly(),
  z
    .object({
      role: z.literal("gateway"),
      version: unsigned(8),
      statusIntervalS: unsigned(8),
      interferenceDb: unsigned(8),
      interferenceS: unsigned(8),
      defaultPowerDbm: z.int(),
      sirenPowerDbm: z.int(),
    })
    .readonly(),
]);

const siteShown = z
  .object({
    channel: siteChannel.nullable(),
    rate: dataRate,
    countdownS: unsigned(8),
    autoStopS: unsigned(16),
    /** The Wi-Fi name as UTF-8 text, or null when none is set. */
    wifiName: z.string().nullable(),
    replyPowerDbm: z.int(),
    sirenPowerDbm: z.int(),
  })
  .readonly();

/** `hsn site change status` (section 9), from the core's state. */
const siteChangeStatusResult = z
  .object({
    kind: z.literal("siteChangeStatus"),
    /** Null when no move was ever made. */
    move: z
      .object({
        id: z.int().min(1),
        stage: z.enum(["announcing", "switched", "done", "cancelled"]),
        channel: siteChannel,
        rate: dataRate,
        forced: z.boolean(),
        /** While announcing: confirmed of total, and each still to confirm with since when. */
        confirmed: z.int().min(0),
        /** After the switch: followed of total, and when the silence grace ends. */
        followed: z.int().min(0),
        total: z.int().min(0),
        waiting: z.array(z.object({ name: deviceName, sinceMs: time }).readonly()).readonly(),
        graceEndsMs: time.nullable(),
      })
      .readonly()
      .nullable(),
  })
  .readonly();

/** A board's latest Identity (§10). */
const usbIdentity = z
  .object({
    role: z.int(),
    chipId: hexBytes,
    firmware: z.string(),
    paired: z.boolean(),
    /** True when it is paired to this hub. */
    ours: z.boolean(),
    hubIdentity: hexBytes.nullable(),
    development: z.boolean(),
  })
  .readonly();

export const commandResult = z.discriminatedUnion("kind", [
  statusResult,
  z.object({ kind: z.literal("arm"), armed: names, waitsForDoorToClose: names }).readonly(),
  z
    .object({
      kind: z.literal("disarm"),
      disarmed: names,
      countdownsCancelled: names,
      alarmEnded: z.boolean(),
    })
    .readonly(),
  z.object({ kind: z.literal("devices"), devices: z.array(deviceSummary).readonly() }).readonly(),
  z
    .object({
      kind: z.literal("deviceShow"),
      device: deviceSummary,
      settings: deviceSettings.nullable(),
      /** The latest status body as hex, for the CLI to decode with `@hsn/protocol`. */
      reading: hexBytes.nullable(),
    })
    .readonly(),
  z
    .object({
      kind: z.literal("usbList"),
      ports: z
        .array(z.object({ port: z.string(), identity: usbIdentity.nullable() }).readonly())
        .readonly(),
    })
    .readonly(),
  z
    .object({
      kind: z.literal("usbAdd"),
      /** The device's number (`devices.id`), as every record of it names it. */
      device: z.int().min(1),
      name: deviceName,
      role: roleName,
      address: unsigned(32),
      /** Its chip identifier, lowercase hex. */
      chip: hexBytes,
    })
    .readonly(),
  z.object({ kind: z.literal("usbErase"), port: z.string() }).readonly(),
  z.object({ kind: z.literal("deviceRename"), name: deviceName }).readonly(),
  z.object({ kind: z.literal("deviceRemove"), name: deviceName }).readonly(),
  z.object({ kind: z.literal("sensorSet"), name: deviceName, version: unsigned(8) }).readonly(),
  z.object({ kind: z.literal("sirenSet"), name: deviceName, version: unsigned(8) }).readonly(),
  z.object({ kind: z.literal("gatewaySet"), name: deviceName, version: unsigned(8) }).readonly(),
  z.object({ kind: z.literal("sirenTest"), name: deviceName, seconds: unsigned(16) }).readonly(),
  z.object({ kind: z.literal("siteShow"), site: siteShown }).readonly(),
  z
    .object({
      kind: z.literal("siteSurvey"),
      channel: siteChannel,
      /** The averaged median noise of each channel surveyed (section 8). */
      noise: z
        .array(z.object({ channel: siteChannel, medianDbm: z.number() }).readonly())
        .readonly(),
    })
    .readonly(),
  z.object({ kind: z.literal("siteSet"), site: siteShown }).readonly(),
  z
    .object({
      kind: z.literal("siteChange"),
      /** "announcing <channel, rate> to N sensors" (section 9). */
      channel: siteChannel,
      rate: dataRate,
      sensors: z.int().min(0),
    })
    .readonly(),
  siteChangeStatusResult,
  z
    .object({
      kind: z.literal("siteChangeCancel"),
      /** "N sensors clear the next settings at their next reply" (section 9). */
      sensors: z.int().min(0),
    })
    .readonly(),
  z
    .object({
      kind: z.literal("siteChangeForce"),
      /** True with `--yes`: the switch went ahead. */
      switched: z.boolean(),
      /** The sensors that would be, or now are, left behind, to be paired again. */
      leftBehind: names,
    })
    .readonly(),
  z.object({ kind: z.literal("siteWifi") }).readonly(),
  z.object({ kind: z.literal("log"), records: z.array(recordJson).readonly() }).readonly(),
  // M2 (m2-design.md section 6): an operation's reply body, as section 6 gives it.
  z.object({ kind: z.literal("op"), body: z.unknown() }).readonly(),
  /** `hsn open`'s console address with its one-time token, and how long it is good for. */
  z
    .object({
      kind: z.literal("consoleToken"),
      url: z.string(),
      expiresInMs: z.int().min(0),
      /** The token's number, for `consoleTokenWait`. */
      token: z.int().min(1),
    })
    .readonly(),
  /** `consoleTokenWait`: whether the token was used, or expired unused. */
  z.object({ kind: z.literal("consoleTokenWait"), used: z.boolean() }).readonly(),
  /** A file chunk taken by the shell (m2-design.md section 6). */
  z.object({ kind: z.literal("fileChunk") }).readonly(),
]);

/** Why a command failed. */
export const controlErrorCode = z.enum([
  /** The request was not valid JSON or not a known command. */
  "badRequest",
  /** A name that is no device, or a device of the wrong role. */
  "unknownDevice",
  "nameTaken",
  /** `hsn arm` without `--continue` found open doors; `names` lists them (D50). */
  "doorsOpen",
  /** A USB port with no board, or one that gave no Identity. */
  "unknownPort",
  /** A board paired to another hub, or already ours (section 9). */
  "boardRefused",
  /** The board did not answer in time; retrying sends the same Provision (section 9). */
  "noAnswer",
  /** Channel and rate are fixed once a sensor or siren is paired (section 8). */
  "sitePaired",
  /** No gateway is connected, which a survey needs (section 8). */
  "noGateway",
  /** `hsn site change` refused: another move is in progress (D115). */
  "moveInProgress",
  /** `hsn site change` refused: the target equals the current settings. */
  "nothingToChange",
  /** Cancel or force after the switch: "switched; a move back is a new move" (section 9). */
  "notAnnouncing",
  /** The hub could not do it: a storage failure or a fault, recorded. */
  "failed",
  // M2.
  /** An operation refused for one of section 5's reasons, given in `app`. */
  "opRefused",
  /** Step 0: the operation's module is a stub. Never sent once M2 is built. */
  "notBuilt",
]);

export const controlError = z
  .object({
    code: controlErrorCode,
    message: z.string(),
    names: names.optional(),
    /** For `op` commands: the operation's own error, as an app would get it (section 5). */
    app: appError.optional(),
  })
  .readonly();

export const controlReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: commandResult }).readonly(),
  z.object({ ok: z.literal(false), error: controlError }).readonly(),
]);

/** The answer to one command, as the core makes it. */
export type ControlReply = z.infer<typeof controlReply>;
export type CommandResult = z.infer<typeof commandResult>;
export type ControlError = z.infer<typeof controlError>;
