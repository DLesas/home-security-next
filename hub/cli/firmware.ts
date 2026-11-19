/**
 * `hsn firmware …` and `hsn rollout …` (docs/m3-updates-design.md section 4, "App operations and
 * events"): the firmware store and rollouts from the hub computer. All but `firmware add` are
 * `hsn op` forms of channel version 2's operations, with readable output; each request's body is
 * checked with its operation's schema before it is sent, and each reply's body with its reply's
 * schema when it comes (a reply that does not parse ends the command: this `hsn` is older than the
 * hub).
 *
 * - `hsn firmware add <file>`: a publisher's `.hsnf` release, uploaded as `hsn update install`
 *   uploads, then `firmware.upload {job}`.
 * - `hsn firmware add <file> --own --version <v>`: an owner's own build, the raw application
 *   image `idf.py build` writes (D35, D84). Before anything is sent the person is told that the
 *   build was not made or checked by the publisher and that every device it is rolled out to will
 *   run it, and must confirm; then `firmware.upload {job, own: {version}, confirmOwn: true}`. The
 *   hub checks the image and marks it an own build everywhere.
 * - `hsn firmware list`, `hsn firmware remove <image>`.
 * - `hsn rollout start <image> [--pilot <device>]…`: devices by name or number.
 * - `hsn rollout status | pause | resume [--device <device> [--force]] | cancel`: the open
 *   rollout's, found by `rollout.status` first.
 */
import {
  APP_OPS_V2,
  type FirmwareImageObject,
  type RolloutDeviceObject,
  type RolloutObject,
} from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import type { ControlError } from "../src/control-protocol/index.ts";
import type { ClientError, Session } from "./client.ts";
import { chunksOf, UPLOAD_JOB } from "./files.ts";
import { directFiles, type NamedFiles } from "./named-files.ts";

/** The firmware and rollout commands that talk to the hub without carrying a file. */
export type FirmwareCommand =
  | { readonly kind: "firmwareList" }
  | { readonly kind: "firmwareRemove"; readonly image: number }
  | { readonly kind: "rolloutStart"; readonly image: number; readonly pilots: readonly string[] }
  | { readonly kind: "rolloutStatus" }
  | { readonly kind: "rolloutPause" }
  | {
      readonly kind: "rolloutResume";
      readonly device: string | undefined;
      readonly force: boolean;
    }
  | { readonly kind: "rolloutCancel" };

/** `hsn firmware add <file> [--own --version <v>]`: a command that carries a file. */
export interface FirmwareAdd {
  readonly kind: "firmwareAdd";
  readonly path: string;
  readonly own: { readonly version: string } | null;
}

/** What went wrong, for `main.ts` to print and turn into an exit code. */
export type FirmwareFailure =
  | { readonly kind: "client"; readonly error: ClientError }
  | { readonly kind: "refused"; readonly error: ControlError }
  /** Refused by `hsn` itself before or after asking: no device of that name, no open rollout. */
  | { readonly kind: "none"; readonly message: string }
  | { readonly kind: "badReply"; readonly message: string }
  | { readonly kind: "file"; readonly message: string }
  | { readonly kind: "declined" };

/** What `hsn` says before adding an own build, and asks (section 3, "An owner's own build"). */
export const OWN_BUILD_WARNING =
  "this build was not made or checked by the publisher; every device you roll it out to will run it";
export const OWN_BUILD_QUESTION = "add it? [y/N] ";

/** The image ids, devices and versions `hsn` takes on its command line. */
const POSITIVE = /^[1-9]\d{0,9}$/u;
const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/u;

/** A version an image header can carry: three numbers, each 0 to 255, without leading zeros. */
function fitsHeader(version: string): boolean {
  const parts = VERSION.exec(version);
  return parts?.slice(1).every((part) => Number(part) <= 255) === true;
}

function usage<T>(message: string): Result<T, string> {
  return err(message);
}

function imageNumber(word: string | undefined, form: string): Result<number, string> {
  if (word === undefined) return usage(form);
  return POSITIVE.test(word) ? ok(Number(word)) : usage(`an image is its number, not "${word}"`);
}

/**
 * The words after `hsn` when they are a firmware or rollout command (but `firmware add`, which
 * `firmwareAddCommand` reads); undefined when they are not one.
 */
export function firmwareCommand(
  words: readonly string[],
): Result<FirmwareCommand, string> | undefined {
  const [first, second, ...rest] = words;
  if (first === "firmware") {
    if (second === "list")
      return rest.length === 0 ? ok({ kind: "firmwareList" }) : usage("firmware list");
    if (second === "remove") {
      if (rest.length > 1) return usage("firmware remove <image>");
      return imageNumber(rest[0], "firmware remove <image>").map((image) => ({
        kind: "firmwareRemove",
        image,
      }));
    }
    if (second === "add") return undefined;
    return usage(
      "firmware add <file> [--own --version <v>] | firmware list | firmware remove <image>",
    );
  }
  if (first !== "rollout") return undefined;
  const form =
    "rollout start <image> [--pilot <device>]… | rollout status | rollout pause | rollout resume [--device <device> [--force]] | rollout cancel";
  switch (second) {
    case "start": {
      const pilots: string[] = [];
      const others: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i] ?? "";
        if (word === "--pilot") {
          const device = rest[i + 1];
          if (device === undefined || device.startsWith("--"))
            return usage("--pilot needs a device");
          pilots.push(device);
          i++;
        } else if (word.startsWith("--")) {
          return usage(`unknown option ${word}`);
        } else {
          others.push(word);
        }
      }
      if (others.length !== 1) return usage("rollout start <image> [--pilot <device>]…");
      return imageNumber(others[0], "rollout start <image>").map((image) => ({
        kind: "rolloutStart",
        image,
        pilots,
      }));
    }
    case "status":
    case "pause":
    case "cancel":
      if (rest.length > 0) return usage(`rollout ${second}`);
      return ok({
        kind:
          second === "status"
            ? "rolloutStatus"
            : second === "pause"
              ? "rolloutPause"
              : "rolloutCancel",
      });
    case "resume": {
      let device: string | undefined;
      let force = false;
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i];
        if (word === "--device" && rest[i + 1] !== undefined && device === undefined) {
          device = rest[i + 1];
          i++;
        } else if (word === "--force" && !force) {
          force = true;
        } else {
          return usage("rollout resume [--device <device> [--force]]");
        }
      }
      if (force && device === undefined) return usage("--force names a device: --device <device>");
      return ok({ kind: "rolloutResume", device, force });
    }
    default:
      return usage(form);
  }
}

/** `firmware add <file> [--own --version <v>]`'s words after `firmware add`. */
export function firmwareAddCommand(words: readonly string[]): Result<FirmwareAdd, string> {
  const form = "firmware add <file> [--own --version <v>]";
  let own = false;
  let version: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--own" && !own) own = true;
    else if (word === "--version" && version === undefined) {
      version = words[i + 1];
      if (version === undefined) return usage("--version needs a version");
      i++;
    } else if (word.startsWith("--")) return usage(`unknown option ${word}: ${form}`);
    else paths.push(word);
  }
  const [path] = paths;
  if (path === undefined || paths.length !== 1) return usage(form);
  if (own !== (version !== undefined))
    return usage("--own and --version go together: an own build names its version");
  if (version !== undefined && !fitsHeader(version))
    return usage(`a version is MAJOR.MINOR.PATCH, each 0 to 255, not "${version}"`);
  return ok({ kind: "firmwareAdd", path, own: version === undefined ? null : { version } });
}

// ----- Talking to the hub -----

/** The operations these commands send, by name. */
type FirmwareOp =
  | "firmware.list"
  | "firmware.upload"
  | "firmware.remove"
  | "rollout.start"
  | "rollout.status"
  | "rollout.pause"
  | "rollout.resume"
  | "rollout.cancel";

/** What a command needs of the terminal. */
export interface FirmwareIo {
  readonly out: (line: string) => void;
  readonly ask: (question: string) => Promise<string>;
  readonly files?: NamedFiles;
}

/** A refusal's words: the hub's own error, as an app would get it. */
function refusedFor(error: ControlError): FirmwareFailure {
  return { kind: "refused", error };
}

/** Sends one operation, its body checked first, its reply's body checked when it comes. */
async function op<N extends FirmwareOp>(
  session: Session,
  actor: string,
  name: N,
  body: unknown,
  timeoutMs: number,
): Promise<Result<ReturnType<(typeof APP_OPS_V2)[N]["reply"]["parse"]>, FirmwareFailure>> {
  const rule = APP_OPS_V2[name];
  const checked = rule.body.safeParse(body);
  if (!checked.success)
    return err({
      kind: "none",
      message: `not valid: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
  const answer = await session.request(
    actor,
    { kind: "op", op: name, body: checked.data },
    timeoutMs,
  );
  if (answer.isErr()) return err({ kind: "client", error: answer.error });
  const reply = answer.value.reply;
  if (!reply.ok) return err(refusedFor(reply.error));
  if (reply.result.kind !== "op") return err(olderThanHub(name));
  const parsed = rule.reply.safeParse(reply.result.body);
  if (!parsed.success) return err(olderThanHub(name));
  return ok(parsed.data as ReturnType<(typeof APP_OPS_V2)[N]["reply"]["parse"]>);
}

function olderThanHub(name: string): FirmwareFailure {
  return {
    kind: "badReply",
    message: `the hub's answer to ${name} is not one this hsn reads: this hsn is older than the hub; install the hub's package for its hsn`,
  };
}

/** The devices' numbers by name, from the snapshot; empty when it cannot be read. */
async function deviceNames(
  session: Session,
  actor: string,
  timeoutMs: number,
): Promise<ReadonlyMap<string, number>> {
  const answer = await session.request(actor, { kind: "op", op: "snapshot", body: {} }, timeoutMs);
  const names = new Map<string, number>();
  if (answer.isErr() || !answer.value.reply.ok || answer.value.reply.result.kind !== "op")
    return names;
  const body: unknown = answer.value.reply.result.body;
  const devices =
    typeof body === "object" && body !== null && "devices" in body ? body.devices : undefined;
  if (!Array.isArray(devices)) return names;
  for (const device of devices as readonly unknown[]) {
    if (typeof device !== "object" || device === null) continue;
    const id = "id" in device ? device.id : undefined;
    const name = "name" in device ? device.name : undefined;
    if (typeof id === "number" && typeof name === "string") names.set(name, id);
  }
  return names;
}

/** A device by number, or by name through the snapshot. */
async function deviceIds(
  words: readonly string[],
  session: Session,
  actor: string,
  timeoutMs: number,
): Promise<Result<readonly number[], FirmwareFailure>> {
  if (words.every((word) => POSITIVE.test(word))) return ok(words.map(Number));
  const names = await deviceNames(session, actor, timeoutMs);
  const ids: number[] = [];
  for (const word of words) {
    const id = POSITIVE.test(word) ? Number(word) : names.get(word);
    if (id === undefined) return err({ kind: "none", message: `no device is called ${word}` });
    ids.push(id);
  }
  return ok(ids);
}

/** The latest time a `Date` holds (ECMAScript's 8.64 × 10¹⁵ ms): past it, the number itself. */
const LAST_DATE_MS = 8_640_000_000_000_000;

/** A wall time from the hub as text; one no date can hold is printed as its number, never thrown. */
function when(ms: number): string {
  return ms <= LAST_DATE_MS ? new Date(ms).toISOString() : `${ms} ms`;
}

const ROLE_NAMES: Readonly<Record<number, string>> = { 1: "sensor", 2: "siren", 3: "gateway" };

/** One stored image, as a line. */
export function imageLine(image: FirmwareImageObject): string {
  const roles = image.roles.map((role) => ROLE_NAMES[role] ?? String(role)).join(" ");
  return `image ${image.id}: ${image.version}, ${image.kind === "ownBuild" ? "own build (not the publisher's)" : "official"}, ${roles}, ${image.bytes} bytes, added ${when(image.addedMs)}, id ${image.imageId}`;
}

/** A rollout, as a line. */
export function rolloutLine(rollout: RolloutObject, named: (id: number) => string): string {
  const parts = [
    `rollout ${rollout.id}: image ${rollout.image} (${rollout.version}), ${rollout.stage}`,
    `${rollout.devices.length} devices`,
    `pilots ${rollout.pilots.length === 0 ? "chosen by the hub" : rollout.pilots.map(named).join(", ")}`,
  ];
  if (rollout.soakUntilMs !== null) parts.push(`soak until ${when(rollout.soakUntilMs)}`);
  if (rollout.paused !== null)
    parts.push(
      `paused: ${rollout.paused.reason}${rollout.paused.device === null ? "" : ` (${named(rollout.paused.device)})`}`,
    );
  if (rollout.endedMs !== null) parts.push(`ended ${when(rollout.endedMs)}`);
  return parts.join(", ");
}

/** A planned device's state in a rollout, as a line. */
export function rolloutDeviceLine(
  device: RolloutDeviceObject,
  named: (id: number) => string,
): string {
  const parts = [`  ${named(device.device)}: ${device.state}`];
  if (device.state === "fetching") parts.push(`${device.bytes} of ${device.of} bytes`);
  parts.push(`method ${device.method}`);
  if (device.held !== null) parts.push(`held: ${device.held}`);
  if (device.lastReason !== null) parts.push(`last reason ${device.lastReason}`);
  return parts.join(", ");
}

function namer(names: ReadonlyMap<string, number>): (id: number) => string {
  const byId = new Map([...names].map(([name, id]) => [id, name]));
  return (id) => {
    const name = byId.get(id);
    return name === undefined ? `device ${id}` : `${name} (${id})`;
  };
}

/** The open rollout's number, from `rollout.status`. */
async function openRollout(
  session: Session,
  actor: string,
  timeoutMs: number,
): Promise<Result<number, FirmwareFailure>> {
  const status = await op(session, actor, "rollout.status", {}, timeoutMs);
  if (status.isErr()) return err(status.error);
  const rollout = status.value.rollout;
  if (rollout?.endedMs !== null) return err({ kind: "none", message: "no rollout is open" });
  return ok(rollout.id);
}

/** Runs one firmware or rollout command on an open session: its lines, or why not. */
export async function runFirmwareCommand(
  command: FirmwareCommand,
  session: Session,
  actor: string,
  timeoutMs: number,
  json: boolean,
): Promise<Result<readonly string[], FirmwareFailure>> {
  const asJson = (body: unknown): readonly string[] => [JSON.stringify(body)];
  switch (command.kind) {
    case "firmwareList": {
      const listed = await op(session, actor, "firmware.list", {}, timeoutMs);
      if (listed.isErr()) return err(listed.error);
      if (json) return ok(asJson(listed.value));
      const named = namer(await deviceNames(session, actor, timeoutMs));
      const lines =
        listed.value.images.length === 0
          ? ["no firmware images are stored"]
          : listed.value.images.map(imageLine);
      for (const device of listed.value.devices) {
        const update = device.update;
        lines.push(
          `${named(device.device)}: runs ${device.version}${update === null ? "" : `, update ${update.state}${update.held === null ? "" : ` (held: ${update.held})`}`}`,
        );
      }
      return ok(lines);
    }
    case "firmwareRemove": {
      const removed = await op(
        session,
        actor,
        "firmware.remove",
        { image: command.image },
        timeoutMs,
      );
      if (removed.isErr()) return err(removed.error);
      return ok(json ? asJson({ removed: command.image }) : [`removed image ${command.image}`]);
    }
    case "rolloutStart": {
      const pilots = await deviceIds(command.pilots, session, actor, timeoutMs);
      if (pilots.isErr()) return err(pilots.error);
      const body =
        pilots.value.length === 0
          ? { image: command.image }
          : { image: command.image, pilots: pilots.value };
      const started = await op(session, actor, "rollout.start", body, timeoutMs);
      if (started.isErr()) return err(started.error);
      if (json) return ok(asJson(started.value));
      const named = namer(await deviceNames(session, actor, timeoutMs));
      return ok([rolloutLine(started.value, named)]);
    }
    case "rolloutStatus": {
      const status = await op(session, actor, "rollout.status", {}, timeoutMs);
      if (status.isErr()) return err(status.error);
      if (json) return ok(asJson(status.value));
      if (status.value.rollout === null) return ok(["no rollout"]);
      const named = namer(await deviceNames(session, actor, timeoutMs));
      return ok([
        rolloutLine(status.value.rollout, named),
        ...status.value.devices.map((device) => rolloutDeviceLine(device, named)),
      ]);
    }
    case "rolloutPause":
    case "rolloutCancel":
    case "rolloutResume": {
      const rollout = await openRollout(session, actor, timeoutMs);
      if (rollout.isErr()) return err(rollout.error);
      let body: Record<string, unknown> = { rollout: rollout.value };
      if (command.kind === "rolloutResume" && command.device !== undefined) {
        const device = await deviceIds([command.device], session, actor, timeoutMs);
        if (device.isErr()) return err(device.error);
        body = { ...body, device: device.value[0], ...(command.force ? { force: true } : {}) };
      }
      const name =
        command.kind === "rolloutPause"
          ? "rollout.pause"
          : command.kind === "rolloutCancel"
            ? "rollout.cancel"
            : "rollout.resume";
      const done = await op(session, actor, name, body, timeoutMs);
      if (done.isErr()) return err(done.error);
      if (json) return ok(asJson(done.value));
      const named = namer(await deviceNames(session, actor, timeoutMs));
      return ok([rolloutLine(done.value, named)]);
    }
  }
}

/**
 * `hsn firmware add`: the file read as the person, an own build confirmed before anything is sent,
 * the file uploaded on this connection, then `firmware.upload` naming it.
 */
export async function runFirmwareAdd(
  command: FirmwareAdd,
  session: Session,
  actor: string,
  io: FirmwareIo,
  timeoutMs: number,
  json: boolean,
): Promise<Result<readonly string[], FirmwareFailure>> {
  const file = await (io.files ?? directFiles).read(command.path);
  if (file.isErr()) return err({ kind: "file", message: file.error });
  if (command.own !== null) {
    io.out(OWN_BUILD_WARNING);
    const answer = await io.ask(OWN_BUILD_QUESTION);
    if (!/^y(?:es)?$/iu.test(answer.trim())) return err({ kind: "declined" });
  }
  for (const chunk of chunksOf(file.value)) {
    const sent = await session.request(actor, chunk, timeoutMs);
    if (sent.isErr()) return err({ kind: "client", error: sent.error });
    if (!sent.value.reply.ok) return err(refusedFor(sent.value.reply.error));
  }
  const body =
    command.own === null
      ? { job: UPLOAD_JOB }
      : { job: UPLOAD_JOB, own: { version: command.own.version }, confirmOwn: true };
  const added = await op(session, actor, "firmware.upload", body, timeoutMs);
  if (added.isErr()) return err(added.error);
  return ok(json ? [JSON.stringify(added.value)] : [`added ${imageLine(added.value)}`]);
}
