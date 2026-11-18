/**
 * Every command of the `hsn` tool (hub-design.md section 9), as the CLI sends it and the core
 * receives it in a `command` input. A field a command does not have is refused, not ignored, so a
 * misspelt option never passes silently. Names refer to devices by their `name`; the core's control
 * module looks them up.
 */
import { type AppOp, fileChunkBody, parseAppOp, RETENTION_DAYS } from "@hsn/protocol/app";
import { z } from "zod";
import { dataRate, deviceName, roleName, siteChannel, time, unsigned } from "./values.ts";

/** Which sensors an arm or disarm applies to: `--all`, or the names given. */
export const sensorTarget = z.union([z.literal("all"), z.array(deviceName).min(1).readonly()]);

const status = z.strictObject({ kind: z.literal("status") }).readonly();

/** `hsn arm [--all | <sensor>…] [--continue]`: without `continue`, an open door stops it (D50). */
const arm = z
  .strictObject({ kind: z.literal("arm"), sensors: sensorTarget, continue: z.boolean() })
  .readonly();

/** `hsn disarm [--all | <sensor>…]` (D95). */
const disarm = z.strictObject({ kind: z.literal("disarm"), sensors: sensorTarget }).readonly();

/** `hsn devices`. */
const devices = z.strictObject({ kind: z.literal("devices") }).readonly();

/** `hsn device show <name>`. */
const deviceShow = z.strictObject({ kind: z.literal("deviceShow"), name: deviceName }).readonly();

/** `hsn usb list`. */
const usbList = z.strictObject({ kind: z.literal("usbList") }).readonly();

/** `hsn usb add <port> --name <name> [--role …]`: sets the role if asked, then provisions (§10). */
const usbAdd = z
  .strictObject({
    kind: z.literal("usbAdd"),
    /** The serial port's path, as `hsn usb list` shows it. */
    port: z.string().min(1),
    name: deviceName,
    role: roleName.optional(),
  })
  .readonly();

/** `hsn usb erase <port>`: development builds only (§10). */
const usbErase = z
  .strictObject({ kind: z.literal("usbErase"), port: z.string().min(1) })
  .readonly();

/** `hsn device rename <old> <new>`. */
const deviceRename = z
  .strictObject({ kind: z.literal("deviceRename"), from: deviceName, to: deviceName })
  .readonly();

/** `hsn device remove <name>`: the key is deleted, the history kept. */
const deviceRemove = z
  .strictObject({ kind: z.literal("deviceRemove"), name: deviceName })
  .readonly();

/**
 * `hsn sensor set <name> countdown=<s> heartbeat=<units> link-check=<n>
 * reply-rate=<DRn|learn> correction=<units|learn>`: each change bumps the version (D86, HB8).
 */
const sensorSet = z
  .strictObject({
    kind: z.literal("sensorSet"),
    name: deviceName,
    /** Seconds (§6, Reply). */
    countdown: unsigned(8).optional(),
    /** Units of 15 seconds (§6, Reply). */
    heartbeat: z.int().min(1).max(255).optional(),
    linkCheck: z.int().min(1).max(255).optional(),
    replyRate: z.union([dataRate, z.literal("learn")]).optional(),
    /** Units of 10 ppm, signed (§6, Reply). */
    correction: z.union([z.int().min(-0x8000).max(0x7fff), z.literal("learn")]).optional(),
  })
  .readonly();

/**
 * A gateway's transmit power: the SX1262's range, −9 to +22 dBm (§6, Transmit request: the
 * gateway clamps, the hub accepts only values inside it).
 */
const gatewayPower = z.int().min(-9).max(22);
/** A status interval, alert level or alert duration: one byte, and 0 is not valid (§6). */
const gatewayByte = z.int().min(1).max(255);

/**
 * `hsn gateway set <name> status=<s> interference=<dB>/<s> power=<dBm> siren-power=<dBm>`: the
 * gateway's own settings (§6, `gateway_config`); each given changes, the rest stay.
 */
const gatewaySet = z
  .strictObject({
    kind: z.literal("gatewaySet"),
    name: deviceName,
    statusS: gatewayByte.optional(),
    interferenceDb: gatewayByte.optional(),
    interferenceS: gatewayByte.optional(),
    powerDbm: gatewayPower.optional(),
    sirenPowerDbm: gatewayPower.optional(),
  })
  .readonly();

/** `hsn siren set <name> max=<s>` (§6, siren settings: 0 is not valid). */
const sirenSet = z
  .strictObject({ kind: z.literal("sirenSet"), name: deviceName, max: z.int().min(1).max(0xffff) })
  .readonly();

/** `hsn siren test <name> [<s>]`: a short test (D65, SR9). */
const sirenTest = z
  .strictObject({
    kind: z.literal("sirenTest"),
    name: deviceName,
    seconds: z.int().min(1).max(0xffff).optional(),
  })
  .readonly();

/** `hsn site show`. */
const siteShow = z.strictObject({ kind: z.literal("siteShow") }).readonly();

/** `hsn site survey`: chooses the quietest channel (section 8). */
const siteSurvey = z.strictObject({ kind: z.literal("siteSurvey") }).readonly();

/**
 * `hsn site set channel=… rate=… countdown=… auto-stop=…`: channel and rate only before
 * pairing (section 8).
 */
const siteSet = z
  .strictObject({
    kind: z.literal("siteSet"),
    channel: siteChannel.optional(),
    rate: dataRate.optional(),
    countdown: unsigned(8).optional(),
    autoStop: z.int().min(1).max(0xffff).optional(),
    /** Retention in days (HB24; m2-design.md section 7): routine 1 to 90 ‡, events 30 to 730 ‡. */
    retentionRoutineDays: z
      .int()
      .min(RETENTION_DAYS.routine.min)
      .max(RETENTION_DAYS.routine.max)
      .optional(),
    retentionEventDays: z
      .int()
      .min(RETENTION_DAYS.event.min)
      .max(RETENTION_DAYS.event.max)
      .optional(),
  })
  .readonly();

/**
 * `hsn site change channel=… rate=…`: move the whole site over the air (D115, section 8); a
 * field left out stays as it is.
 */
const siteChange = z
  .strictObject({
    kind: z.literal("siteChange"),
    channel: siteChannel.optional(),
    rate: dataRate.optional(),
  })
  .readonly();

/** `hsn site change status`: the stage and who is still to confirm or follow. */
const siteChangeStatus = z.strictObject({ kind: z.literal("siteChangeStatus") }).readonly();

/** `hsn site change cancel`: only while announcing. */
const siteChangeCancel = z.strictObject({ kind: z.literal("siteChangeCancel") }).readonly();

/** `hsn site change force [--yes]`: without `yes` it only names who would be left behind. */
const siteChangeForce = z
  .strictObject({ kind: z.literal("siteChangeForce"), yes: z.boolean() })
  .readonly();

/** `hsn site wifi --name <n> --password <p>`: carried to devices as UTF-8 bytes (§9). */
const siteWifi = z
  .strictObject({ kind: z.literal("siteWifi"), name: z.string(), password: z.string() })
  .readonly();

/** The kinds `hsn log --kind` filters on. */
export const logKind = z.enum(["rx", "tx", "decision", "log", "event", "reject", "notification"]);

/** `hsn log [--device <name>] [--since <time>] [--kind …] [--follow]`. */
const log = z
  .strictObject({
    kind: z.literal("log"),
    device: deviceName.optional(),
    /** Wall milliseconds. */
    since: time.optional(),
    logKind: logKind.optional(),
    follow: z.boolean(),
  })
  .readonly();

/**
 * M2 (m2-design.md section 6): "the hub computer's own commands gain the same operations under
 * the same names". These are the operations `hsn` and the bench may send as `{kind: "op"}`, with
 * the body section 6 gives each. Left out: those a session alone has (`subscribe`, `pong`,
 * `backup.key`, a client's own `notifications.read` and `notifications.prefs`), and those `hsn`
 * already has under its own names (devices, sensors, sirens, gateways, USB, the site, `hsn log`
 * for `history.query`). `hsn op <operation> [<json> | -]` sends `{kind: "op", op, body}`. The
 * three that carry a file (`update.upload`, `restore.start`, `backup.export`) are here for
 * `hsn update install`, `hsn restore` and `hsn backup export`, which send them on the connection
 * that carries the file's `fileChunk` requests or lines (section 6, "Commands that carry a file").
 */
export const CONTROL_OPS = [
  "snapshot",
  "hub.info",
  "hub.status",
  "mode.switch",
  "arm",
  "disarm",
  "group.create",
  "group.update",
  "group.delete",
  "mode.create",
  "mode.update",
  "mode.delete",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "notifications.list",
  "people.list",
  "person.create",
  "person.rename",
  "person.remove",
  "permissions.set",
  "userManagement.set",
  "clients.list",
  "client.rename",
  "client.remove",
  "link.create",
  "link.cancel",
  "backup.status",
  "backup.settings",
  "backup.now",
  "backup.export",
  "restore.start",
  "update.status",
  "update.upload",
  "update.approve",
  "update.cancel",
] as const;

/**
 * Channel version 2's operations `hsn` carries (the joint step 0 of M3 and M4): the relay's
 * (`hsn op relay.status`, `relay.set`, `update.offers`, `update.fetch`; m4-design section 9), the
 * firmware store's and rollouts' (m3-updates-design section 4: `hsn firmware list|remove`,
 * `hsn rollout start|status|pause|resume|cancel` are `hsn op` forms), `firmware.upload` for
 * `hsn firmware add <file> [--own --version <v>]`, which uploads the file as `hsn update install`
 * does and sends `{job, own?, confirmOwn?}`, and `firmware.bluetooth` for the bench. The phone's
 * own operations (`push.*`, `presence.set`, `backup.keyHeld`) and `pair.*` are not the hub
 * computer's. The `op` command takes them once the core routes version 2 (docs/m3-m4-plan.md,
 * step 2); until then it refuses them as it refuses any name `CONTROL_OPS` does not hold.
 */
export const CONTROL_OPS_V2 = [
  "relay.status",
  "relay.set",
  "update.offers",
  "update.fetch",
  "firmware.list",
  "firmware.offers",
  "firmware.fetch",
  "firmware.upload",
  "firmware.remove",
  "firmware.bluetooth",
  "firmware.download",
  "rollout.start",
  "rollout.pause",
  "rollout.resume",
  "rollout.cancel",
  "rollout.status",
] as const;

const controlOps: ReadonlySet<string> = new Set(CONTROL_OPS);

/** `hsn <operation> [<json body>]`: an app operation from the hub computer (m2-design.md section 6). */
const op = z
  .strictObject({ kind: z.literal("op"), op: z.string(), body: z.unknown() })
  .superRefine((value, ctx) => {
    if (!controlOps.has(value.op)) {
      ctx.addIssue({
        code: "custom",
        path: ["op"],
        message: "not an operation of the hub computer",
      });
      return;
    }
    const parsed = parseAppOp(value.op, value.body);
    if (!parsed.ok)
      for (const issue of parsed.issues) ctx.addIssue({ code: "custom", message: issue });
  })
  .readonly();

/**
 * One chunk of a file `hsn` uploads on its connection, the app's `fileChunk` body (m2-design.md
 * section 6): the shell answers it itself, keeping the upload for the operation that names its
 * `job`. It never reaches the core.
 */
const fileChunk = z
  .strictObject({ kind: z.literal("fileChunk"), ...fileChunkBody.unwrap().shape })
  .readonly();

/** `hsn open`: a one-time console token for the computer's own browser (section 5, "The console"). */
const consoleToken = z
  .strictObject({
    kind: z.literal("consoleToken"),
    /**
     * Who asks, which sets the token's lifetime (section 11, "Step 1, wave 2"): `hsn open`, 2
     * minutes ‡, by default; an installer's first opening, 10 minutes ‡.
     */
    for: z.enum(["open", "installer"]).optional(),
  })
  .readonly();

/**
 * `hsn open` waits for its console token (section 5, "The console"): answered `{used}` when the
 * token is used, or expires unused. No access time and no port is read.
 */
const consoleTokenWait = z
  .strictObject({ kind: z.literal("consoleTokenWait"), token: z.int().min(1) })
  .readonly();

/**
 * The lockstep hub's test-only restore (docs/m3-updates-design.md section 7, "How it is proven"):
 * `restore {file, key}` runs `applyRestore` on the backup `file` with the backup key the controller
 * gives, and restarts the hub. Accepted only with `--bench-lockstep`, as its seeded keys are (HD
 * 11); the wire stays at version 2, since it travels as a control line. The shell refuses it on
 * every other control socket before the core sees it. `RemoteHub.restore()` sends it.
 */
const benchRestore = z
  .strictObject({
    kind: z.literal("benchRestore"),
    /** The backup file's path, on the hub computer. */
    file: z.string().min(1),
    /** The backup key, 32 bytes as base64url (43 characters). */
    key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "32 bytes as base64url"),
  })
  .readonly();

export const controlCommand = z.discriminatedUnion("kind", [
  status,
  arm,
  disarm,
  devices,
  deviceShow,
  usbList,
  usbAdd,
  usbErase,
  deviceRename,
  deviceRemove,
  sensorSet,
  gatewaySet,
  sirenSet,
  sirenTest,
  siteShow,
  siteSurvey,
  siteSet,
  siteChange,
  siteChangeStatus,
  siteChangeCancel,
  siteChangeForce,
  siteWifi,
  log,
  op,
  consoleToken,
  consoleTokenWait,
  fileChunk,
  // The joint step 0 of M3 and M4.
  benchRestore,
]);

/**
 * One command, as the core receives it. An `op` command arrives checked against its operation's
 * schema (the refinement above), so the core sees its operation as the `AppOp` it is, without Zod.
 * A `fileChunk` is the shell's alone and never reaches the core.
 */
export type ControlCommand =
  | Exclude<ParsedControlCommand, { readonly kind: "op" | "fileChunk" }>
  | { readonly kind: "op"; readonly operation: AppOp };

/** A file chunk `hsn` sends, which the shell answers itself. */
export type FileChunkCommand = Extract<ParsedControlCommand, { readonly kind: "fileChunk" }>;

/** The longest control line, either way: 64 KiB ‡, above the largest chunk's line (section 6). */
export const CONTROL_LINE_BYTES = 64 * 1024;

/** A command as the schema gives it back: an `op`'s body not yet typed by its operation. */
export type ParsedControlCommand = z.infer<typeof controlCommand>;

/**
 * The command the core receives, from one the schema accepted: an `op` typed as its `AppOp`.
 * Undefined for a `fileChunk`, which the shell answers before this, and if the schema let through
 * an operation `parseAppOp` refuses, which its refinement does not.
 */
export function typedCommand(parsed: ParsedControlCommand): ControlCommand | undefined {
  if (parsed.kind === "fileChunk") return undefined;
  if (parsed.kind !== "op") return parsed;
  const op = parseAppOp(parsed.op, parsed.body);
  return op.ok ? { kind: "op", operation: op.value } : undefined;
}
export type ControlCommandKind = ControlCommand["kind"];
