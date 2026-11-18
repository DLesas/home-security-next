/**
 * The app channel's error codes and their details (docs/m2-design.md section 5, "Requests,
 * replies and events"). Every refusal is one of these; `notBuilt` is step 0's own, so a test can
 * tell an operation not built yet from a real refusal, and goes once every operation is built.
 *
 * Channel version 2's refusals are in `errors-v2.ts`: no new code, new `what`, `reason` and
 * `because` values only, kept apart so version 1's lists stay what version 1 clients know.
 */
import { z } from "zod";
import {
  groupObject,
  modeObject,
  optionalCategory,
  personObject,
  scheduleObject,
} from "./objects.ts";
import { deviceRef, revision, seqValue } from "./values.ts";

export const APP_ERROR_CODES = [
  "unauthorized",
  "needsConfirmation",
  "conflict",
  "seqTooLow",
  "notFound",
  "invalid",
  "busy",
  "consoleOnly",
  "unavailable",
  "protoUnsupported",
  /** Step 0: the operation's module is a stub. Never sent once M2 is built. */
  "notBuilt",
] as const;

export const appErrorCode = z.enum(APP_ERROR_CODES);
export type AppErrorCode = z.infer<typeof appErrorCode>;

/** A global permission (D33). */
export const globalPermission = z.enum(["manageUsers", "manageSystem"]);

/** `unauthorized`: the sensors the person may not manage, or the permission missing. */
export const unauthorizedDetail = z
  .strictObject({
    devices: z.array(deviceRef).readonly().optional(),
    permission: globalPermission.optional(),
  })
  .readonly();

/** `needsConfirmation`: the open doors and the low batteries (D50, AL12). */
export const needsConfirmationDetail = z
  .strictObject({
    openDoors: z.array(deviceRef).readonly(),
    lowBattery: z.array(deviceRef).readonly(),
  })
  .readonly();

/**
 * `conflict`: the object's current revision, and the object itself, required, as that operation's
 * reply carries it (the group, mode, schedule, person, permissions or preferences), so the app can
 * show the change it lost to. An object deleted meanwhile is `notFound`, never `conflict`.
 */
export const conflictDetail = z
  .strictObject({
    revision,
    object: z.union([
      groupObject,
      modeObject,
      scheduleObject,
      personObject,
      z.strictObject({ categories: z.array(optionalCategory).readonly(), revision }).readonly(),
    ]),
  })
  .readonly();

/** `seqTooLow`: the client's last accepted `seq`. */
export const seqTooLowDetail = z.strictObject({ last: seqValue }).readonly();

/** `notFound`: what kind of thing the request named, and the number it gave. */
export const NOT_FOUND_WHATS = [
  "person",
  "client",
  "group",
  "mode",
  "schedule",
  "device",
  "token",
  "notification",
  "job",
  "upload",
] as const;
const notFoundDetail = z
  .strictObject({
    what: z.enum(NOT_FOUND_WHATS),
    id: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .readonly();

/** Why a value is `invalid` (section 5). */
export const INVALID_REASONS = [
  /** The shape, or a name's rule. */
  "format",
  "range",
  /** A name already used. */
  "taken",
  /** An id that names nothing of that kind. */
  "unknownReference",
  /** A fixed mode (D90). */
  "fixed",
  /** Named by schedules: `refs` their ids. */
  "inUse",
  /** The last person with manage users. */
  "lastManager",
  /** A removal's `also` linked more than 30 days ago. */
  "tooOld",
  /** `restore.start` on a hub with devices. */
  "noDevicesRequired",
  /** A board that gave no answer (M1a's `noAnswer`). */
  "noAnswer",
  /** No gateway to send through (M1a's `noGateway`). */
  "noGateway",
  /** A release or backup file that is not one (section 9). */
  "badFile",
  /** A release whose signature no key the hub carries verifies (D84). */
  "badSignature",
  /** A release for another system or architecture. */
  "wrongSystem",
  /** A release not newer than the running version. */
  "notNewer",
  /** No room for the update or its copy. */
  "full",
] as const;

/** `invalid`: the body's path, dotted (`devices.2.manage`, `name`), and why. */
const invalidDetail = z
  .strictObject({
    field: z.string(),
    reason: z.enum(INVALID_REASONS),
    refs: z.array(z.int().min(1)).readonly().optional(),
  })
  .readonly();

/** `busy`: what is in progress; `upload` is a second upload on one connection. */
export const BUSY_BECAUSE = [
  "siteMove",
  "updateSwitch",
  "provisioning",
  "countdown",
  "alarm",
  "restore",
  "upload",
] as const;
const busyDetail = z.strictObject({ because: z.enum(BUSY_BECAUSE) }).readonly();

/**
 * One error, with every `detail` exactly as section 5's table gives it. `protoUnsupported` is the
 * shell's answer to an operation the agreed version does not name; a request of the wrong shape is
 * answered `invalid {field, reason: "format"}` by the shell.
 */
export const appError = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("unauthorized"), detail: unauthorizedDetail }).readonly(),
  z
    .strictObject({ code: z.literal("needsConfirmation"), detail: needsConfirmationDetail })
    .readonly(),
  z.strictObject({ code: z.literal("conflict"), detail: conflictDetail }).readonly(),
  z.strictObject({ code: z.literal("seqTooLow"), detail: seqTooLowDetail }).readonly(),
  z.strictObject({ code: z.literal("notFound"), detail: notFoundDetail }).readonly(),
  z.strictObject({ code: z.literal("invalid"), detail: invalidDetail }).readonly(),
  z.strictObject({ code: z.literal("busy"), detail: busyDetail }).readonly(),
  z.strictObject({ code: z.literal("consoleOnly"), detail: z.strictObject({}) }).readonly(),
  z.strictObject({ code: z.literal("unavailable"), detail: z.strictObject({}) }).readonly(),
  z
    .strictObject({
      code: z.literal("protoUnsupported"),
      /** The hub's range of versions. */
      detail: z.strictObject({ speaks: z.tuple([z.int().min(1), z.int().min(1)]) }),
    })
    .readonly(),
  z
    .strictObject({ code: z.literal("notBuilt"), detail: z.strictObject({ op: z.string() }) })
    .readonly(),
]);
export type AppError = z.infer<typeof appError>;
