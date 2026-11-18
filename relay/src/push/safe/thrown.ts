/**
 * Turning a thrown value into a `PushError` (docs/hub-design.md section 10's `thrown.ts`, for the
 * push role). Every `try` of `relay/src/push/` lives in this folder.
 *
 * A library's message may quote what it was given: `JSON.parse` quotes the text, `node:http2`
 * quotes an invalid header's value, `node:crypto` may quote a key's form. Here that text is a
 * credential file, a push token or a JWT, so the message is kept only when the caller says the
 * input holds no secret (`withMessage`); otherwise only the error's code is.
 */
import { type PushError, type PushErrorKind, pushError } from "../errors.ts";

/** The error's own code, when the library gives one: `ENOENT`, `ERR_HTTP2_STREAM_ERROR`. */
export function thrownCode(thrown: unknown): string | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;
  const code: unknown = "code" in thrown ? thrown.code : undefined;
  if (typeof code === "string") return code;
  return "cause" in thrown && thrown.cause !== thrown ? thrownCode(thrown.cause) : undefined;
}

/** Whether a thrown value's message may be kept: only when its input held no secret. */
export type ThrownMessage = "withMessage" | "codeOnly";

/** A `PushError` of `kind` from `origin`: `what` failed, with the thrown value's code. */
export function errorFrom(
  kind: PushErrorKind,
  origin: string,
  what: string,
  thrown: unknown,
  message: ThrownMessage,
): PushError {
  const code = thrownCode(thrown);
  const text =
    message === "withMessage" && thrown instanceof Error ? `${what}: ${thrown.message}` : what;
  return code === undefined
    ? pushError(kind, origin, text)
    : pushError(kind, origin, text, { code });
}
