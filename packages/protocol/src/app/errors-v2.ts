/**
 * Channel version 2's errors (docs/m3-m4-plan.md, "Error codes"): M2's scheme, with no new code.
 * Every refusal the three designs add is a new `notFound` `what`, `invalid` `reason` or `busy`
 * `because`, listed here after version 1's, each with its design. Version 1's lists (errors.ts)
 * stay what a version 1 client knows; the hub sends these only on a version 2 session.
 * `refusals-v2.ts` places each design's named refusals in this scheme.
 */
import { z } from "zod";
import {
  BUSY_BECAUSE,
  conflictDetail,
  INVALID_REASONS,
  needsConfirmationDetail,
  NOT_FOUND_WHATS,
  seqTooLowDetail,
  unauthorizedDetail,
} from "./errors.ts";

/** `notFound`'s `what` in version 2. */
export const NOT_FOUND_WHATS_V2 = [
  ...NOT_FOUND_WHATS,
  // m3-updates-design section 4: a stored firmware image (`firmware_images.id`), a rollout.
  "image",
  "rollout",
] as const;

/** `invalid`'s `reason` in version 2. */
export const INVALID_REASONS_V2 = [
  ...INVALID_REASONS,
  // ----- Pairing over Bluetooth (m3-design section 5, `pair.prepare`) -----
  /** The board is paired to another hub: its owner holds its button 15 s first. */
  "pairedElsewhere",
  /** The board is already paired to this hub and in use. */
  "alreadyOurs",
  /** A siren or a gateway, and the site has no Wi-Fi details (`site.wifi` first). */
  "noWifi",
  /** Not an Identity message a board of ours sends. */
  "badIdentity",
  // ----- Firmware files (m3-updates-design section 3) and the relay (m4-design section 2) -----
  /** A firmware file for another chip or board (`.hsnf` target, or the image's own header). */
  "wrongTarget",
  /** Over the slot's 3.5 MB, or an offered release over the 8 MB cap, refused before fetching. */
  "tooLarge",
  /** The store holds four images, or 8 MB, already (D140): a person removes one first. */
  "storeFull",
  /** An owner's own build without `confirmOwn` (D35, D84). */
  "notConfirmed",
  /** `relay.set`: a `ws://` URL to an address that is not loopback or private (RD 2). */
  "notLocal",
  // ----- `firmware.bluetooth` and rollouts (m3-updates-design sections 4 and 5) -----
  /** The device is armed (held: armed). */
  "armed",
  /** The device's battery is under the floor (held: battery). */
  "lowBattery",
  /** The device is not paired to this hub, or not contacted yet. */
  "notPaired",
  /** No image is planned for the device: no rollout names it. */
  "noImage",
  /** The device's role is not among the image's roles. */
  "wrongRole",
] as const;

/** `busy`'s `because` in version 2. */
export const BUSY_BECAUSE_V2 = [
  ...BUSY_BECAUSE,
  // m3-updates-design sections 4, 5 and 7.
  /** A rollout is open already (at most one not ended). */
  "rollout",
  /** The device runs an image on trial: held while it checks itself. */
  "onTrial",
  /** The device is not heard yet under its new key after a restore (held: keyChange, D141). */
  "keyChange",
] as const;

/** One error of version 2: version 1's codes and details, with the lists above. */
export const appErrorV2 = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("unauthorized"), detail: unauthorizedDetail }).readonly(),
  z
    .strictObject({ code: z.literal("needsConfirmation"), detail: needsConfirmationDetail })
    .readonly(),
  z.strictObject({ code: z.literal("conflict"), detail: conflictDetail }).readonly(),
  z.strictObject({ code: z.literal("seqTooLow"), detail: seqTooLowDetail }).readonly(),
  z
    .strictObject({
      code: z.literal("notFound"),
      detail: z
        .strictObject({
          what: z.enum(NOT_FOUND_WHATS_V2),
          id: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
        })
        .readonly(),
    })
    .readonly(),
  z
    .strictObject({
      code: z.literal("invalid"),
      detail: z
        .strictObject({
          field: z.string(),
          reason: z.enum(INVALID_REASONS_V2),
          refs: z.array(z.int().min(1)).readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
  z
    .strictObject({
      code: z.literal("busy"),
      detail: z.strictObject({ because: z.enum(BUSY_BECAUSE_V2) }).readonly(),
    })
    .readonly(),
  z.strictObject({ code: z.literal("consoleOnly"), detail: z.strictObject({}) }).readonly(),
  z.strictObject({ code: z.literal("unavailable"), detail: z.strictObject({}) }).readonly(),
  z
    .strictObject({
      code: z.literal("protoUnsupported"),
      detail: z.strictObject({ speaks: z.tuple([z.int().min(1), z.int().min(1)]) }),
    })
    .readonly(),
  z
    .strictObject({ code: z.literal("notBuilt"), detail: z.strictObject({ op: z.string() }) })
    .readonly(),
]);
export type AppErrorV2 = z.infer<typeof appErrorV2>;
export type InvalidReasonV2 = (typeof INVALID_REASONS_V2)[number];
export type BusyBecauseV2 = (typeof BUSY_BECAUSE_V2)[number];
