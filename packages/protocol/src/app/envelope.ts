/**
 * The JSON inside transport messages (docs/m2-design.md section 5, "Requests, replies and
 * events"): one object each.
 *
 *   client → hub   {"t":"req","id":N,"seq":S?,"op":"<name>","body":{…}}
 *   hub → client   {"t":"res","id":N,"ok":true,"body":{…},"repeat"?:true}
 *                  {"t":"res","id":N,"ok":false,"error":{"code":"<code>","detail":{…}}}
 *                  {"t":"evt","rev":R,"ev":"<name>","body":{…}}
 */
import type { LinkResult, RestoreOffer, RestoreResult } from "./handshake.ts";
import { z } from "zod";
import { appError } from "./errors.ts";
import { APP_EVENT_NAMES, APP_EVENTS, type AppEventBody, type AppEventName } from "./events.ts";
import { APP_OPS, type AppOp, parseAppOp } from "./ops.ts";
import { liveRevision, requestIdValue, seqValue } from "./values.ts";

/** A request's frame before its body is checked against its operation. */
export const requestFrame = z
  .strictObject({
    t: z.literal("req"),
    id: requestIdValue,
    seq: seqValue.optional(),
    op: z.string(),
    body: z.unknown(),
  })
  .readonly();

/** A request, as the core sees it (section 2, "What the core sees of an app request"). */
export interface AppRequest {
  readonly id: number;
  /** Per client; present on every change (the shell checks it), absent on a read. */
  readonly seq: number | undefined;
  readonly op: AppOp;
}

export type ParsedRequest =
  | { readonly ok: true; readonly value: AppRequest }
  | { readonly ok: false; readonly id: number | undefined; readonly issues: readonly string[] };

/**
 * What the shell checks before the core sees a request (section 2): the frame, the operation's
 * body, and that a change carries `seq` and a read does not. Never throws.
 */
export function parseRequest(json: unknown): ParsedRequest {
  const frame = requestFrame.safeParse(json);
  if (!frame.success) {
    return { ok: false, id: undefined, issues: frame.error.issues.map((i) => i.message) };
  }
  const { id, seq, op, body } = frame.data;
  const parsed = parseAppOp(op, body);
  if (!parsed.ok) return { ok: false, id, issues: parsed.issues };
  const change = APP_OPS[parsed.value.op].change;
  if (change && seq === undefined) return { ok: false, id, issues: ["seq: a change carries one"] };
  if (!change && seq !== undefined) return { ok: false, id, issues: ["seq: a read carries none"] };
  return { ok: true, value: { id, seq, op: parsed.value } };
}

/** A successful reply; `repeat` when it is a stored reply sent again for a retried `seq`. */
export const replyOk = z
  .strictObject({
    t: z.literal("res"),
    id: requestIdValue,
    ok: z.literal(true),
    body: z.unknown(),
    repeat: z.literal(true).optional(),
  })
  .readonly();

/** A refusal. */
export const replyError = z
  .strictObject({
    t: z.literal("res"),
    id: requestIdValue,
    ok: z.literal(false),
    error: appError,
    repeat: z.literal(true).optional(),
  })
  .readonly();

export const appReply = z.discriminatedUnion("ok", [replyOk, replyError]);
export type AppReply = z.infer<typeof appReply>;

/** An event's frame. */
export const eventFrame = z
  .strictObject({
    t: z.literal("evt"),
    rev: liveRevision,
    ev: z.enum(APP_EVENT_NAMES as [AppEventName, ...AppEventName[]]),
    body: z.unknown(),
  })
  .readonly();

/** An event, typed by name. */
export type AppEvent = {
  readonly [N in AppEventName]: {
    readonly t: "evt";
    readonly rev: number;
    readonly ev: N;
    readonly body: AppEventBody<N>;
  };
}[AppEventName];

/** Checks an event's frame and body. Never throws. */
export function parseEvent(
  json: unknown,
):
  | { readonly ok: true; readonly value: AppEvent }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const frame = eventFrame.safeParse(json);
  if (!frame.success) return { ok: false, issues: frame.error.issues.map((i) => i.message) };
  const body = APP_EVENTS[frame.data.ev].safeParse(frame.data.body);
  if (!body.success) return { ok: false, issues: body.error.issues.map((i) => i.message) };
  // The schema of `ev` checked `body`, so the frame is that variant of `AppEvent`.
  return { ok: true, value: { ...frame.data, body: body.data } as AppEvent };
}

/**
 * A handshake's transport payload from the core (section 5): linking's message 4 (`LinkResult`),
 * restore's message 4 (`RestoreOffer`) or 6 (`RestoreResult`), sent as the transport message's
 * JSON, `body` alone. After `LinkResult` or `RestoreResult` the shell closes the connection.
 */
export interface AppHandshakeMessage {
  readonly kind: "handshake";
  readonly body: LinkResult | RestoreOffer | RestoreResult;
}

/**
 * What the hub sends a client inside the channel (`appSend`, section 2): a reply or an event on a
 * session, or a handshake's payload on a link or restore connection.
 */
export type AppMessage = AppReply | AppEvent | AppHandshakeMessage;
