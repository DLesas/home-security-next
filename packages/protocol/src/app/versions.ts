/**
 * The channel's versions side by side (docs/m2-design.md section 5, "Versions"; docs/m3-m4-plan.md:
 * one version 2 for the three designs). The hub speaks 1 and 2 once its shell is moved to it
 * (`HUB_PROTO` becomes `[1, 2]`, m4-design section 9); its web app speaks 2, the phone 2 only.
 *
 * A session agrees one version at its handshake. The shell checks every request against that
 * version's table: an operation the version does not name is answered `protoUnsupported` and
 * recorded `notInVersion` (section 5); a version 1 session never sees a version 2 object, since
 * version 1's are parsed strictly by version 1 clients.
 */
import { APP_EVENTS, type AppEventName } from "./events.ts";
import { APP_EVENTS_V2, type AppEventNameV2 } from "./events-v2.ts";
import { z as zod } from "zod";
import { replyOk, requestFrame } from "./envelope.ts";
import { type AppError, appError } from "./errors.ts";
import { type AppErrorV2, appErrorV2 } from "./errors-v2.ts";
import { requestIdValue } from "./values.ts";
import { APP_OPS, type AppOpName } from "./ops.ts";
import { APP_OPS_V2, type AppOpNameV2, type AppOpV2 } from "./ops-v2.ts";

/** Every version of the channel, oldest first. */
export const APP_PROTO_VERSIONS = [1, 2] as const;
export type AppProtoVersion = (typeof APP_PROTO_VERSIONS)[number];
/** The newest version: what the hub computer's own commands speak. */
export const APP_PROTO_LATEST: AppProtoVersion = 2;

/** Each version's operations. */
export const APP_OPS_BY_VERSION = { 1: APP_OPS, 2: APP_OPS_V2 } as const;
/** Each version's events. */
export const APP_EVENTS_BY_VERSION = { 1: APP_EVENTS, 2: APP_EVENTS_V2 } as const;

/** True when `version` names `op`. */
export function isOpInVersion(op: string, version: AppProtoVersion): op is AppOpNameV2 {
  return Object.hasOwn(APP_OPS_BY_VERSION[version], op);
}

/** True when `version` names the event `ev`. */
export function isEventInVersion(ev: string, version: AppProtoVersion): ev is AppEventNameV2 {
  return Object.hasOwn(APP_EVENTS_BY_VERSION[version], ev);
}

/** The first version that names each operation. */
export function opSince(op: AppOpNameV2): AppProtoVersion {
  return Object.hasOwn(APP_OPS, op) ? 1 : 2;
}

/** A version 1 operation's name, narrowed. */
export function isVersion1Op(op: AppOpNameV2): op is AppOpName {
  return Object.hasOwn(APP_OPS, op);
}

/** A version 1 event's name, narrowed. */
export function isVersion1Event(ev: AppEventNameV2): ev is AppEventName {
  return Object.hasOwn(APP_EVENTS, ev);
}

/** What `parseAppOpIn` found: the operation, the version not naming it, or the schema's issues. */
export type ParsedOpIn =
  | { readonly ok: true; readonly value: AppOpV2 }
  | { readonly ok: false; readonly notInVersion: true; readonly issues: readonly string[] }
  | { readonly ok: false; readonly notInVersion: false; readonly issues: readonly string[] };

/**
 * Checks an operation's name and body against one version's table. Never throws. An operation
 * the version does not name is `notInVersion` (the shell answers `protoUnsupported`); one no
 * version names is a wrong shape (`invalid`), as in version 1.
 */
export function parseAppOpIn(version: AppProtoVersion, op: unknown, body: unknown): ParsedOpIn {
  if (typeof op !== "string" || !Object.hasOwn(APP_OPS_V2, op))
    return { ok: false, notInVersion: false, issues: ["op: not an operation of any version"] };
  if (!isOpInVersion(op, version))
    return {
      ok: false,
      notInVersion: true,
      issues: [`op: not an operation of version ${String(version)}`],
    };
  const table: Readonly<Record<string, { readonly body: zod.ZodType } | undefined>> =
    APP_OPS_BY_VERSION[version];
  const rule = table[op];
  if (rule === undefined)
    return {
      ok: false,
      notInVersion: true,
      issues: [`op: not an operation of version ${String(version)}`],
    };
  const parsed = rule.body.safeParse(body);
  if (!parsed.success)
    return {
      ok: false,
      notInVersion: false,
      issues: parsed.error.issues.map((i) => `body.${i.path.join(".")}: ${i.message}`),
    };
  // The version's schema of `op` checked `body`, so the pair is that variant of `AppOpV2`.
  const value = { op, body: parsed.data } as AppOpV2;
  return { ok: true, value };
}

/**
 * A request of either version, as the core will see it once the shell agrees version 2 (step 2:
 * `clientRequest` carries it then; until then the shell speaks version 1 and gives `AppRequest`).
 */
export interface AppRequestV2 {
  readonly id: number;
  readonly seq: number | undefined;
  readonly op: AppOpV2;
}

export type ParsedRequestIn =
  | { readonly ok: true; readonly value: AppRequestV2 }
  | {
      readonly ok: false;
      readonly id: number | undefined;
      readonly notInVersion: boolean;
      readonly issues: readonly string[];
    };

/**
 * `parseRequest` for a session of `version`: the frame, the operation in that version, its body,
 * and that a change carries `seq` and a read does not. Never throws. `parseRequest` itself stays
 * version 1's.
 */
export function parseRequestIn(version: AppProtoVersion, json: unknown): ParsedRequestIn {
  const frame = requestFrame.safeParse(json);
  if (!frame.success)
    return {
      ok: false,
      id: undefined,
      notInVersion: false,
      issues: frame.error.issues.map((i) => i.message),
    };
  const { id, seq, op, body } = frame.data;
  const parsed = parseAppOpIn(version, op, body);
  if (!parsed.ok)
    return { ok: false, id, notInVersion: parsed.notInVersion, issues: parsed.issues };
  const change = APP_OPS_V2[parsed.value.op].change;
  if (change && seq === undefined)
    return { ok: false, id, notInVersion: false, issues: ["seq: a change carries one"] };
  if (!change && seq !== undefined)
    return { ok: false, id, notInVersion: false, issues: ["seq: a read carries none"] };
  return { ok: true, value: { id, seq, op: parsed.value } };
}

/** A refusal on a version 2 session: version 2's error scheme (`appErrorV2`). */
export const replyErrorV2 = zod
  .strictObject({
    t: zod.literal("res"),
    id: requestIdValue,
    ok: zod.literal(false),
    error: appErrorV2,
    repeat: zod.literal(true).optional(),
  })
  .readonly();

/** A reply on a version 2 session. */
export const appReplyV2 = zod.discriminatedUnion("ok", [replyOk, replyErrorV2]);
export type AppReplyV2 = zod.infer<typeof appReplyV2>;

/**
 * Whether an error is one of version 1's: its code, and every value of its detail, in version 1's
 * lists (`appError`). Every error a module makes with version 1's types is; a version 2 error that
 * uses only version 1's values is too, and is sent as it is.
 */
export function isAppErrorV1(error: AppErrorV2): error is AppError {
  return appError.safeParse(error).success;
}

/**
 * The error a version 1 session is sent for `error` (docs/m3-m4-plan.md: "a version 1 session never
 * sees a version 2 object"): the error itself when it is one of version 1's, else
 * `protoUnsupported` with the versions this package speaks, since only version 2 can say it. An
 * operation's outcome may carry a version 2 error (`OpOutcome`); every reply to a version 1
 * session passes through here, so its client never has to parse a value it does not know.
 */
export function version1Error(error: AppErrorV2): AppError {
  return isAppErrorV1(error)
    ? error
    : { code: "protoUnsupported", detail: { speaks: [APP_PROTO_VERSIONS[0], APP_PROTO_LATEST] } };
}
