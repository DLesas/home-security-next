/**
 * A change's reply, as `app` sends it and `people` keeps it for a retry with the same `seq`
 * (m2-design.md section 5, "`seq` gives every change exactly one effect"; section 4,
 * `client_replies`: "the reply as sent, UTF-8 JSON"). One function makes it, so the reply kept is
 * the reply sent.
 *
 * **By the session's channel version** (docs/m3-m4-plan.md): an outcome carries version 2's
 * errors (`OpOutcome`). A version 2 session is sent a refusal as it is; a version 1 session only
 * what version 1 can say, through `version1Error` (anything else is `protoUnsupported`), so its
 * reply, and the bytes kept of it, are what they were before version 2 existed.
 */
import { Result } from "neverthrow";
import {
  type AppProtoVersion,
  type AppReply,
  appReply,
  type AppReplyV2,
  appReplyV2,
  version1Error,
} from "@hsn/protocol/app";
import type { OpOutcome } from "../model/messages.ts";

/** A reply of either version. */
export type AnyReply = AppReply | AppReplyV2;

/** The reply to request `id` with this outcome (section 5's frames), on a session of `proto`. */
export function replyOf(id: number, outcome: OpOutcome): AppReply;
export function replyOf(
  id: number,
  outcome: OpOutcome,
  proto: AppProtoVersion | undefined,
): AnyReply;
export function replyOf(id: number, outcome: OpOutcome, proto: AppProtoVersion = 1): AnyReply {
  if (outcome.ok) return { t: "res", id, ok: true, body: outcome.body };
  return proto === 2
    ? { t: "res", id, ok: false, error: outcome.error }
    : { t: "res", id, ok: false, error: version1Error(outcome.error) };
}

/**
 * A reply as a session of `proto` may be sent it: a version 1 session never a version 2 error
 * (a reply kept for a change made on a version 2 session, retried on a version 1 one).
 */
export function replyForVersion(reply: AnyReply, proto: AppProtoVersion): AnyReply {
  if (proto === 2 || reply.ok) return reply;
  return { ...reply, error: version1Error(reply.error) };
}

/** A kept reply sent again for a retried `seq`: the retry's own `id`, marked `repeat`. */
export function repeatOf<R extends AnyReply>(reply: R, id: number): R {
  return { ...reply, id, repeat: true };
}

const encoder = new TextEncoder();

/** `client_replies.reply`: the reply as sent, UTF-8 JSON. */
export function encodeReply(reply: AnyReply): Uint8Array {
  return encoder.encode(JSON.stringify(reply));
}

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  () => "not JSON",
);

/**
 * A kept reply read back at boot, or undefined when its bytes are not one (a database written by
 * something else): that `seq` is then answered `seqTooLow`, as one no longer kept. A reply kept
 * for a version 2 session may hold an error only version 2 names; it is read as version 2's.
 */
export function decodeReply(bytes: Uint8Array): AnyReply | undefined {
  const text = new TextDecoder().decode(bytes);
  const json = parseJson(text);
  if (json.isErr()) return undefined;
  const v1 = appReply.safeParse(json.value);
  if (v1.success) return v1.data;
  const v2 = appReplyV2.safeParse(json.value);
  return v2.success ? v2.data : undefined;
}
