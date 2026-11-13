/**
 * The bench's lockstep messages (hub-design.md section 11, "Lockstep"): with
 * `--bench-lockstep <socket>`, the bench drives the hub's clock and carries its links on one
 * socket, one JSON message per line. Times are microseconds on the bench's true clock, which
 * is the hub's `mono` in this mode.
 */
import { z } from "zod";
import { requestLine, replyLine } from "./envelope.ts";
import { recordJson } from "./records.ts";
import { hexBytes, time } from "./values.ts";

/** A link as the bench names it: the device and link kind, as in the manifest. */
const linkName = z.string().min(1);

/** Bench to hub: handle every frame given with time ≤ `to`, then answer `idle`. */
const advance = z.strictObject({ type: z.literal("advance"), to: time }).readonly();

/** Bench to hub: one packet or setup message that arrived on a link at `at`. */
const frameIn = z
  .strictObject({ type: z.literal("frame"), link: linkName, at: time, bytes: hexBytes })
  .readonly();

/**
 * Bench to hub: a link came up or went down. SPEC-QUESTION: section 11 names only `advance`,
 * `frame` and `idle`, but the hub's links must open and close (`drop_link`, a sensor's USB power
 * turned off); these two messages carry that.
 */
const linkUp = z
  .strictObject({
    type: z.literal("linkUp"),
    link: linkName,
    kind: z.enum(["usb", "network"]),
    at: time,
  })
  .readonly();
const linkDown = z
  .strictObject({ type: z.literal("linkDown"), link: linkName, at: time })
  .readonly();

/** Bench to hub: a control command, as on the control socket (`RemoteHub`'s calls). */
const control = z.strictObject({ type: z.literal("control"), request: requestLine }).readonly();

export const lockstepToHub = z.discriminatedUnion("type", [
  advance,
  frameIn,
  linkUp,
  linkDown,
  control,
]);

/** A frame the hub sent during the advance, with the time it left. */
const frameOut = z.object({ link: linkName, at: time, bytes: hexBytes }).readonly();

/**
 * Hub to bench, after each `advance`: the frames it sent, the records it made, and its next
 * deadline, or null for none. The bench answers its record questions from these, never from
 * the database (section 11).
 */
const idle = z
  .object({
    type: z.literal("idle"),
    frames: z.array(frameOut).readonly(),
    records: z.array(recordJson).readonly(),
    wake: time.nullable(),
  })
  .readonly();

/** Hub to bench: the answer to a `control` message. */
const reply = z.object({ type: z.literal("reply"), reply: replyLine }).readonly();

export const lockstepFromHub = z.discriminatedUnion("type", [idle, reply]);

export type LockstepToHub = z.infer<typeof lockstepToHub>;
export type LockstepFromHub = z.infer<typeof lockstepFromHub>;
