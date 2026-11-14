/**
 * Every operation of the app channel (docs/m2-design.md section 6), one entry per row of its
 * table: whether it is a change (and so carries `seq`), who may make it, its body and its reply.
 * The hub's control protocol carries the same operations under the same names for `hsn`.
 */
import { z } from "zod";
import {
  clientObject,
  deviceObject,
  groupObject,
  historyKind,
  historyRow,
  hubInfo,
  modeObject,
  notificationObject,
  optionalCategory,
  personObject,
  scheduleAction,
  scheduleDays,
  scheduleObject,
  scheduleTarget,
  siteMoveStatus,
  siteObject,
  sirenChoice,
  snapshotObject,
  topic,
} from "./objects.ts";
import { APP_LISTS, FILE_CHUNKS } from "./constants.ts";
import {
  base64urlBytes,
  clientRef,
  dataRateValue,
  deviceNameValue,
  deviceRef,
  displayName,
  durationMs,
  groupRef,
  jobRef,
  localTimeText,
  modeRef,
  personRef,
  recordSeqValue,
  revision,
  roleValue,
  scheduleRef,
  sha256Hex,
  siteChannelValue,
  tokenRef,
  wallMs,
} from "./values.ts";

/**
 * Who may make an operation (section 6's "Who" column): `any` linked person; `own` for oneself
 * or one's own client; `device` by the devices it names (V or M); `MU` manage users; `MS` manage
 * system; and `console`, only on the console listener (C). The hub computer's commands have
 * every permission (HD 9). The full rule is the design's text, kept beside it.
 */
export interface OpRule {
  readonly change: boolean;
  readonly scope: "any" | "own" | "device" | "MU" | "MS";
  readonly console: boolean;
  /** Section 6's "Who" cell, verbatim. */
  readonly who: string;
}

const empty = z.strictObject({}).readonly();
const ok = z.strictObject({}).readonly();

/** The confirmation a person gives for open doors and low batteries (D50, AL12). */
export const confirmation = z
  .strictObject({ openDoors: z.boolean(), lowBattery: z.boolean() })
  .readonly();

const armingResult = z
  .strictObject({
    armed: z.array(deviceRef).readonly(),
    disarmed: z.array(deviceRef).readonly(),
    waiting: z.array(deviceRef).readonly(),
  })
  .readonly();

const armTarget = z.union([
  z.strictObject({ group: groupRef }).readonly(),
  z.strictObject({ sensor: deviceRef }).readonly(),
]);

const groupFields = {
  name: displayName,
  sensors: z.array(deviceRef).readonly(),
  sirens: sirenChoice,
};
const modeFields = { name: displayName, groups: z.array(groupRef).readonly() };
const scheduleFields = {
  name: displayName,
  action: scheduleAction,
  target: scheduleTarget,
  at: localTimeText,
  days: scheduleDays,
  enabled: z.boolean(),
};

const settingsVersion = z.strictObject({ version: z.int().min(1).max(255) }).readonly();

/**
 * A file's chunks: `fileChunk` requests or events of at most 48 KB ‡, numbered from 0, ending
 * with a SHA-256 of the whole. An upload's `job` is the client's, unique among its uploads on that
 * connection; the core names the finished upload `UploadRef {conn, job}` (section 6).
 */
export const fileChunkBody = z
  .strictObject({
    job: jobRef,
    n: z.int().min(0),
    /** The chunk's bytes, as base64url without padding (section 6). */
    data: base64urlBytes.max(Math.ceil((FILE_CHUNKS.maxChunkBytes * 4) / 3)),
    /** On the last chunk: how many chunks, and the SHA-256 of the whole file. */
    end: z
      .strictObject({ chunks: z.int().min(1), sha256: sha256Hex })
      .readonly()
      .optional(),
  })
  .readonly();

/** `link.create`'s kinds (section 6): a new person, or another device of one's own. */
const linkKind = z.union([
  z
    .strictObject({ newPerson: z.strictObject({ name: displayName.optional() }).readonly() })
    .readonly(),
  z.literal("ownDevice"),
]);

const sensorSettings = z
  .strictObject({
    sensor: deviceRef,
    countdown: z.int().min(0).max(255).optional(),
    heartbeat: z.int().min(1).max(255).optional(),
    linkCheck: z.int().min(1).max(255).optional(),
    replyRate: z.union([dataRateValue, z.literal("learn")]).optional(),
    correction: z.union([z.int().min(-32_768).max(32_767), z.literal("learn")]).optional(),
  })
  .readonly();

const gatewayPower = z.int().min(-9).max(22);
const gatewayByte = z.int().min(1).max(255);

function op<B extends z.ZodType, R extends z.ZodType>(rule: OpRule, body: B, reply: R) {
  return { ...rule, body, reply } as const;
}

const C = (who: string, scope: OpRule["scope"], console = false): OpRule => ({
  change: true,
  scope,
  console,
  who,
});
const R = (who: string, scope: OpRule["scope"], console = false): OpRule => ({
  change: false,
  scope,
  console,
  who,
});

/** The operations, by name. */
export const APP_OPS = {
  snapshot: op(
    R("any", "any"),
    z.strictObject({ topics: z.array(topic).readonly().optional() }).readonly(),
    snapshotObject,
  ),
  subscribe: op(
    R("any", "any"),
    z.strictObject({ topics: z.array(topic).readonly() }).readonly(),
    z.strictObject({ topics: z.array(topic).readonly() }).readonly(),
  ),
  "hub.info": op(R("any", "any"), empty, hubInfo),
  "hub.status": op(
    R("MS", "MS"),
    empty,
    z
      .strictObject({
        lastCommitMs: wallMs.nullable(),
        stagedItems: z.int().min(0),
        databaseBytes: z.int().min(0).nullable(),
        historyShortened: z.boolean(),
        missingAfterRestartMs: wallMs.nullable(),
      })
      .readonly(),
  ),
  "mode.switch": op(
    C("M of every sensor whose state would change (HB5a)", "device"),
    z.strictObject({ mode: modeRef, confirm: confirmation.optional() }).readonly(),
    armingResult,
  ),
  arm: op(
    C("M of every sensor whose state would change", "device"),
    z.strictObject({ target: armTarget, confirm: confirmation.optional() }).readonly(),
    armingResult,
  ),
  disarm: op(
    C("M of every sensor named; `mine` needs none", "device"),
    z.strictObject({ target: z.union([armTarget, z.literal("mine")]) }).readonly(),
    z
      .strictObject({
        disarmed: z.array(deviceRef).readonly(),
        alarmEnded: z.boolean(),
        alarmContinues: z
          .strictObject({ triggers: z.array(deviceRef).readonly() })
          .readonly()
          .optional(),
      })
      .readonly(),
  ),
  "group.create": op(C("MS", "MS"), z.strictObject(groupFields).readonly(), groupObject),
  "group.update": op(
    C("MS", "MS"),
    z.strictObject({ group: groupRef, ...groupFields, ifRevision: revision }).readonly(),
    groupObject,
  ),
  "group.delete": op(
    C("MS", "MS"),
    z.strictObject({ group: groupRef, ifRevision: revision }).readonly(),
    ok,
  ),
  "mode.create": op(C("MS", "MS"), z.strictObject(modeFields).readonly(), modeObject),
  "mode.update": op(
    C("MS", "MS"),
    z.strictObject({ mode: modeRef, ...modeFields, ifRevision: revision }).readonly(),
    modeObject,
  ),
  "mode.delete": op(
    C("MS", "MS"),
    z.strictObject({ mode: modeRef, ifRevision: revision }).readonly(),
    ok,
  ),
  "schedule.create": op(C("MS", "MS"), z.strictObject(scheduleFields).readonly(), scheduleObject),
  "schedule.update": op(
    C("MS", "MS"),
    z.strictObject({ schedule: scheduleRef, ...scheduleFields, ifRevision: revision }).readonly(),
    scheduleObject,
  ),
  "schedule.delete": op(
    C("MS", "MS"),
    z.strictObject({ schedule: scheduleRef, ifRevision: revision }).readonly(),
    ok,
  ),
  "device.list": op(
    R("V(d) (sirens and gateways: any ‡)", "device"),
    empty,
    z.strictObject({ devices: z.array(deviceObject).readonly() }).readonly(),
  ),
  "device.show": op(
    R("V(d) (sirens and gateways: any ‡)", "device"),
    z.strictObject({ device: deviceRef }).readonly(),
    deviceObject,
  ),
  "device.rename": op(
    C("MS", "MS"),
    // No `ifRevision`: devices have no revision (section 4).
    z.strictObject({ device: deviceRef, name: deviceNameValue }).readonly(),
    deviceObject,
  ),
  "device.remove": op(
    C("MS", "MS"),
    z.strictObject({ device: deviceRef }).readonly(),
    deviceObject,
  ),
  "sensor.settings": op(
    C("M(d) for countdown and heartbeat; MS for reply rate and correction", "device"),
    sensorSettings,
    settingsVersion,
  ),
  "siren.settings": op(
    C("MS", "MS"),
    z.strictObject({ siren: deviceRef, max: z.int().min(1).max(0xffff) }).readonly(),
    settingsVersion,
  ),
  "siren.test": op(
    C("MS", "MS"),
    z.strictObject({ siren: deviceRef, seconds: z.int().min(1).max(0xffff).optional() }).readonly(),
    z.strictObject({ seconds: z.int().min(1), decision: recordSeqValue }).readonly(),
  ),
  "gateway.settings": op(
    C("MS", "MS"),
    z
      .strictObject({
        gateway: deviceRef,
        statusS: gatewayByte.optional(),
        interferenceDb: gatewayByte.optional(),
        interferenceS: gatewayByte.optional(),
        powerDbm: gatewayPower.optional(),
        sirenPowerDbm: gatewayPower.optional(),
      })
      .readonly(),
    settingsVersion,
  ),
  "usb.list": op(
    R("MS, C", "MS", true),
    empty,
    z
      .strictObject({
        ports: z
          .array(
            z
              .strictObject({
                port: z.string(),
                identity: z
                  .strictObject({
                    role: roleValue.nullable(),
                    chipId: z.string(),
                    firmware: z.string(),
                    paired: z.enum(["no", "toThisHub", "toAnotherHub"]),
                    development: z.boolean(),
                  })
                  .readonly()
                  .nullable(),
              })
              .readonly(),
          )
          .readonly(),
      })
      .readonly(),
  ),
  "usb.add": op(
    C("MS, C", "MS", true),
    z
      .strictObject({ port: z.string().min(1), name: deviceNameValue, role: roleValue.optional() })
      .readonly(),
    deviceObject,
  ),
  "usb.erase": op(
    C("MS, C", "MS", true),
    z.strictObject({ port: z.string().min(1) }).readonly(),
    ok,
  ),
  "site.show": op(R("any", "any"), empty, siteObject),
  "site.set": op(
    C("MS", "MS"),
    z
      .strictObject({
        channel: siteChannelValue.optional(),
        rate: dataRateValue.optional(),
        countdown: z.int().min(0).max(255).optional(),
        autoStop: z.int().min(1).max(0xffff).optional(),
      })
      .readonly(),
    siteObject,
  ),
  "site.wifi": op(
    C("MS (C ‡)", "MS", true),
    z.strictObject({ name: z.string().min(1), password: z.string() }).readonly(),
    siteObject,
  ),
  "site.survey": op(
    C("MS", "MS"),
    empty,
    z.strictObject({ channel: siteChannelValue, rate: dataRateValue }).readonly(),
  ),
  "site.change": op(
    C("MS", "MS"),
    z.union([
      z
        .strictObject({
          start: z
            .strictObject({ channel: siteChannelValue.optional(), rate: dataRateValue.optional() })
            .readonly(),
        })
        .readonly(),
      z.literal("cancel"),
      z.strictObject({ force: z.strictObject({ yes: z.boolean() }).readonly() }).readonly(),
    ]),
    siteMoveStatus,
  ),
  "site.changeStatus": op(R("MS", "MS"), empty, siteMoveStatus.nullable()),
  "history.query": op(
    R("V of each device it returns", "device"),
    z
      .strictObject({
        devices: z.array(deviceRef).readonly().optional(),
        kinds: z.array(historyKind).readonly().optional(),
        since: wallMs.optional(),
        until: wallMs.optional(),
        before: recordSeqValue.optional(),
        limit: z.int().min(1).max(APP_LISTS.maxHistoryRows),
      })
      .readonly(),
    z
      .strictObject({ rows: z.array(historyRow).readonly(), next: recordSeqValue.optional() })
      .readonly(),
  ),
  "notifications.list": op(
    R("any (own)", "own"),
    z
      .strictObject({
        before: recordSeqValue.optional(),
        limit: z.int().min(1).max(APP_LISTS.maxNotifications),
      })
      .readonly(),
    z.strictObject({ notifications: z.array(notificationObject).readonly() }).readonly(),
  ),
  "notifications.read": op(
    C("any (own)", "own"),
    z.strictObject({ seqs: z.array(recordSeqValue).min(1).readonly() }).readonly(),
    ok,
  ),
  "notifications.prefs": op(
    C("any (own client)", "own"),
    z.strictObject({ categories: z.array(optionalCategory).readonly() }).readonly(),
    z.strictObject({ categories: z.array(optionalCategory).readonly(), revision }).readonly(),
  ),
  "people.list": op(
    R("MU; any for oneself", "MU"),
    empty,
    z
      .strictObject({
        userManagement: z.boolean(),
        people: z.array(personObject).readonly(),
        clients: z.array(clientObject).readonly(),
      })
      .readonly(),
  ),
  "person.create": op(
    C("MU", "MU"),
    z.strictObject({ name: displayName }).readonly(),
    personObject,
  ),
  "person.rename": op(
    C("MU", "MU"),
    z.strictObject({ person: personRef, name: displayName, ifRevision: revision }).readonly(),
    personObject,
  ),
  "person.remove": op(
    C("MU", "MU"),
    z.strictObject({ person: personRef, ifRevision: revision }).readonly(),
    ok,
  ),
  "permissions.set": op(
    C("MU", "MU"),
    z
      .strictObject({
        person: personRef,
        devices: z
          .array(
            z
              .strictObject({ device: deviceRef, manage: z.boolean(), view: z.boolean() })
              .readonly(),
          )
          .readonly(),
        manageUsers: z.boolean(),
        manageSystem: z.boolean(),
        ifRevision: revision,
      })
      .readonly(),
    personObject,
  ),
  "userManagement.set": op(C("MU", "MU"), z.strictObject({ on: z.boolean() }).readonly(), ok),
  "clients.list": op(
    R("any for own; MU for all", "own"),
    empty,
    z.strictObject({ clients: z.array(clientObject).readonly() }).readonly(),
  ),
  "client.rename": op(
    C("own; MU for others", "own"),
    z.strictObject({ client: clientRef, name: displayName }).readonly(),
    ok,
  ),
  "client.remove": op(
    C("own; MU for others", "own"),
    // `also`: the clients it linked in the last 30 days ‡ that go with it, the ones left ticked
    // (section 7), so a client linked after the list was shown is never removed unseen.
    z
      .strictObject({
        client: clientRef,
        also: z
          .array(clientRef)
          .refine((ids) => new Set(ids).size === ids.length, "no client twice")
          .readonly(),
      })
      .readonly(),
    ok,
  ),
  "link.create": op(
    C("MU for a new person; any for one's own device", "any"),
    z
      .strictObject({
        kind: linkKind,
        form: z.enum(["qr", "code", "url"]),
        invite: z.boolean().optional(),
      })
      .readonly(),
    z
      .strictObject({
        token: tokenRef,
        qr: z.string().optional(),
        code: z.string().optional(),
        url: z.string().optional(),
        expiresInMs: durationMs,
      })
      .readonly(),
  ),
  "link.cancel": op(
    C("the maker, or MU", "own"),
    z.strictObject({ token: tokenRef }).readonly(),
    ok,
  ),
  pong: op(R("any", "any"), empty, ok),
  "backup.key": op(
    R("a phone that holds an older epoch", "own"),
    empty,
    z.strictObject({ key: base64urlBytes.length(43), epoch: z.int().min(0) }).readonly(),
  ),
  "backup.status": op(
    R("MS", "MS"),
    empty,
    z
      .strictObject({
        folder: z.string().nullable(),
        hour: z.int().min(0).max(23),
        keep: z.int().min(1),
        newestMs: wallMs.nullable(),
        due: z.boolean(),
        lastResult: z.enum(["ok", "failed", "never"]),
      })
      .readonly(),
  ),
  "backup.settings": op(
    C("MS; the folder C", "MS"),
    z
      .strictObject({
        folder: z.string().min(1).optional(),
        hour: z.int().min(0).max(23).optional(),
        keep: z.int().min(1).optional(),
      })
      .readonly(),
    ok,
  ),
  "backup.now": op(C("MS", "MS"), empty, z.strictObject({ job: jobRef }).readonly()),
  "backup.export": op(
    C("MS", "MS"),
    z.strictObject({ history: z.boolean() }).readonly(),
    z.strictObject({ job: jobRef }).readonly(),
  ),
  // A read: nothing durable changes until the phone's key arrives (section 9).
  "restore.start": op(
    R("C, on a hub with no devices", "MS", true),
    z.strictObject({ job: jobRef }).readonly(),
    z
      .strictObject({
        /** The hub the file came from (26 characters). */
        identity: z.string(),
        madeMs: wallMs,
        /** How old its people and permissions are (D122). */
        lastChangeMs: wallMs,
        /** The restore token as a QR code, `hsn://restore/1?…`. */
        qr: z.string(),
      })
      .readonly(),
  ),
  "update.status": op(
    R("MS", "MS"),
    empty,
    z
      .strictObject({
        staged: z.string().nullable(),
        approvedBy: z.string().nullable(),
        switching: z.boolean(),
        lastResult: z.enum(["none", "healthy", "rolledBack"]),
      })
      .readonly(),
  ),
  "update.upload": op(
    C("MS, C", "MS", true),
    z.strictObject({ job: jobRef }).readonly(),
    z.strictObject({ version: z.string() }).readonly(),
  ),
  "update.approve": op(C("MS", "MS"), empty, z.strictObject({ switchWhen: z.string() }).readonly()),
  "update.cancel": op(C("MS", "MS"), empty, ok),
  // Not a change: no `seq`, and a repeated chunk is the same bytes. The shell answers it itself.
  fileChunk: op(R("as the operation the file belongs to", "any"), fileChunkBody, ok),
} as const;

/** Every operation's name. */
export type AppOpName = keyof typeof APP_OPS;
export const APP_OP_NAMES = Object.keys(APP_OPS) as readonly AppOpName[];

/** One operation's body, by name. */
export type AppOpBody<N extends AppOpName> = z.infer<(typeof APP_OPS)[N]["body"]>;
/** One operation's successful reply body, by name. */
export type AppOpReply<N extends AppOpName> = z.infer<(typeof APP_OPS)[N]["reply"]>;

/** The changes: every operation that carries `seq`. */
export const CHANGE_OPS = APP_OP_NAMES.filter((name) => APP_OPS[name].change);

/** An operation and its body, as the core sees it: one variant per row of section 6. */
export type AppOp = {
  readonly [N in AppOpName]: { readonly op: N; readonly body: AppOpBody<N> };
}[AppOpName];

/** What `parseAppOp` found: the operation, or the schema's issues as path and message. */
export type ParsedOp =
  | { readonly ok: true; readonly value: AppOp }
  | { readonly ok: false; readonly issues: readonly string[] };

function isOpName(name: unknown): name is AppOpName {
  return typeof name === "string" && Object.hasOwn(APP_OPS, name);
}

/**
 * Checks an operation's name and body against section 6's schemas: what the shell does before a
 * request reaches the core (section 2, "What the core sees of an app request"). Never throws.
 */
export function parseAppOp(op: unknown, body: unknown): ParsedOp {
  if (!isOpName(op)) return { ok: false, issues: [`op: not an operation of version 1`] };
  const parsed = APP_OPS[op].body.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `body.${i.path.join(".")}: ${i.message}`),
    };
  }
  // The schema of `op` checked `body`, so the pair is that variant of `AppOp`.
  const value = { op, body: parsed.data } as AppOp;
  return { ok: true, value };
}

/** The chunk limit, for the reader of `fileChunkBody`. */
export const FILE_CHUNK_BYTES = FILE_CHUNKS.maxChunkBytes;
