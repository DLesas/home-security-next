/**
 * A change's reply, as `app` sends it and `people` keeps it for a retry with the same `seq`
 * (m2-design.md section 5, "`seq` gives every change exactly one effect"; section 4,
 * `client_replies`: "the reply as sent, UTF-8 JSON"). One function makes it, so the reply kept is
 * the reply sent.
 */
import { Result } from "neverthrow";
import { type AppReply, appReply, version1Error } from "@hsn/protocol/app";
import type { OpOutcome } from "../model/messages.ts";

/** The reply to request `id` with this outcome (section 5's frames). */
export function replyOf(id: number, outcome: OpOutcome): AppReply {
  return outcome.ok
    ? { t: "res", id, ok: true, body: outcome.body }
    : { t: "res", id, ok: false, error: version1Error(outcome.error) };
}

/** A kept reply sent again for a retried `seq`: the retry's own `id`, marked `repeat`. */
export function repeatOf(reply: AppReply, id: number): AppReply {
  return { ...reply, id, repeat: true };
}

const encoder = new TextEncoder();

/** `client_replies.reply`: the reply as sent, UTF-8 JSON. */
export function encodeReply(reply: AppReply): Uint8Array {
  return encoder.encode(JSON.stringify(reply));
}

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  () => "not JSON",
);

/**
 * A kept reply read back at boot, or undefined when its bytes are not one (a database written by
 * something else): that `seq` is then answered `seqTooLow`, as one no longer kept.
 */
export function decodeReply(bytes: Uint8Array): AppReply | undefined {
  const text = new TextDecoder().decode(bytes);
  const json = parseJson(text);
  if (json.isErr()) return undefined;
  const parsed = appReply.safeParse(json.value);
  return parsed.success ? parsed.data : undefined;
}
