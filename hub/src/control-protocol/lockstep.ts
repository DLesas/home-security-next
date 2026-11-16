/**
 * The lockstep wire (hub-design.md section 11, "Lockstep: the wire"): with
 * `--bench-lockstep <socket>`, the bench (the controller) drives the hub's clock and carries its
 * links and control commands on one Unix socket, one JSON object per line. Section 11 is the
 * contract; this file is its one definition in code.
 *
 * Times (`at`, `to`, `wake`) are whole microseconds on the controller's true clock, which is the
 * hub's monotonic clock in this mode and never goes back, across hub restarts too. Wall times
 * (`wall`) are milliseconds since 1970 (UTC). Bytes are lowercase hex, two digits a byte.
 */
import { z } from "zod";
import { requestLine, replyLine } from "./envelope.ts";
import { recordJson } from "./records.ts";
import { hexBytes, time } from "./values.ts";

/** The wire's version: `start` names it, and the hub refuses any other. */
export const LOCKSTEP_VERSION = 2;

/** A link as the controller names it, unique within a run (by convention `<device>:<kind>`). */
const linkName = z.string().min(1).max(128);

/** A wall time in milliseconds since 1970. */
const wallMs = z.int().min(0);

/**
 * Controller to hub, first on every connection: the run's clock and seed. The hub opens its
 * database (migrations, the snapshot), makes its keys at the first start from the seed, and
 * handles its boot at `at`; it answers `idle`.
 */
const start = z
  .strictObject({
    type: z.literal("start"),
    version: z.literal(LOCKSTEP_VERSION),
    at: time,
    wall: wallMs,
    trusted: z.boolean(),
    /**
     * Where the hub's own monotonic clock begins at `at`, in microseconds; 0 when left out. The
     * hub's clock starts again at every `start`, as a real hub's does at every restart.
     */
    mono: time.optional(),
    /** 32 bytes: with the boot's number, every random byte the hub uses in this run comes from it. */
    seed: hexBytes.length(64),
    /**
     * The hub computer's time zone, an IANA name (`Europe/London`): given to the core as
     * `timeZone` in the turn of the boot, as `main.ts` gives the system's. Left out, the hub has
     * none, as before, and no schedule entry has a next time. The lockstep hub never reads the
     * computer's own zone, so a run is the same on any machine. A zone the calendar does not
     * know is refused (`error`) before anything starts. An older hub refuses the field (`start`
     * is strict), so a controller is never silently ignored.
     */
    zone: z.string().min(1).max(64).optional(),
  })
  .readonly();

/** Controller to hub: handle every input with `at` ≤ `to` and every timer due by then; answer `idle`. */
const advance = z.strictObject({ type: z.literal("advance"), to: time }).readonly();

/** Controller to hub: one frame (a packet or a setup message) that arrived on a link at `at`. */
const frameIn = z
  .strictObject({ type: z.literal("frame"), link: linkName, at: time, bytes: hexBytes.min(2) })
  .readonly();

/** Controller to hub: a link came up at `at` (a USB port plugged in, a WebSocket accepted). */
const linkUp = z
  .strictObject({
    type: z.literal("linkUp"),
    link: linkName,
    kind: z.enum(["usb", "network"]),
    at: time,
  })
  .readonly();

/** Controller to hub: a link went down at `at`, from the far end. */
const linkDown = z
  .strictObject({ type: z.literal("linkDown"), link: linkName, at: time })
  .readonly();

/** Controller to hub: an `hsn` command arriving at `at`, as a control socket line (section 9). */
const control = z
  .strictObject({ type: z.literal("control"), at: time, request: requestLine })
  .readonly();

/** Controller to hub: from `at`, the wall clock reads `wall` and is trusted or not. */
const clock = z
  .strictObject({ type: z.literal("clock"), at: time, wall: wallMs, trusted: z.boolean() })
  .readonly();

/**
 * Controller to hub: stop cleanly at `at`, as on SIGTERM: everything up to `at` is handled, then
 * one commit with the clean-stop mark; the hub answers `stopped` and exits 0.
 */
const stop = z.strictObject({ type: z.literal("stop"), at: time }).readonly();

export const lockstepToHub = z.discriminatedUnion("type", [
  start,
  advance,
  frameIn,
  linkUp,
  linkDown,
  control,
  clock,
  stop,
]);

/** A frame the hub sent, on a link, at the time it left. */
const frameOut = z.strictObject({ link: linkName, at: time, bytes: hexBytes }).readonly();

/**
 * A link the hub closed itself (version 2): when, and why, in the hub's words (a gateway session
 * replaced or never proven, a gateway removed, a text message on a WebSocket…). Its device sees
 * the link go down, as on a real WebSocket or port.
 */
const closedOut = z.strictObject({ link: linkName, at: time, reason: z.string() }).readonly();

/**
 * Hub to controller, after `start`, each `advance` and `stop`: what happened up to `to`, in the
 * order it happened: the frames it sent, the links it closed, the records it made, the answers to commands, and its
 * next wake (null for none). The controller answers its record questions from these, never from
 * the database (section 11).
 */
const idle = z
  .strictObject({
    type: z.literal("idle"),
    to: time,
    /** This run's boot (`boots.id`). */
    boot: z.int().min(1),
    frames: z.array(frameOut).readonly(),
    /** The links the hub closed since the last `idle`, in order (version 2). */
    closed: z.array(closedOut).readonly(),
    records: z.array(recordJson).readonly(),
    replies: z.array(replyLine).readonly(),
    wake: time.nullable(),
  })
  .readonly();

/** Hub to controller, after the `idle` that answers `stop`: the clean stop is committed. */
const stopped = z.strictObject({ type: z.literal("stopped"), at: time }).readonly();

/**
 * Hub to controller: a line it could not take (not JSON, not a message, a time in the past, a
 * second `start`). The hub then exits with code 65 without committing anything more.
 */
const error = z
  .strictObject({ type: z.literal("error"), message: z.string(), line: z.string() })
  .readonly();

export const lockstepFromHub = z.discriminatedUnion("type", [idle, stopped, error]);

export type LockstepToHub = z.infer<typeof lockstepToHub>;
export type LockstepFromHub = z.infer<typeof lockstepFromHub>;
export type LockstepIdle = z.infer<typeof idle>;
