/**
 * Every command of the `hsn` tool (hub-design.md section 9), as the CLI sends it and the core
 * receives it in a `command` input. A field a command does not have is refused, not ignored, so a
 * misspelt option never passes silently. Names refer to devices by their `name`; the core's control
 * module looks them up.
 */
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
export const logKind = z.enum(["rx", "tx", "decision", "log", "event", "reject"]);

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
]);

/** One command, as the core receives it. */
export type ControlCommand = z.infer<typeof controlCommand>;
export type ControlCommandKind = ControlCommand["kind"];
