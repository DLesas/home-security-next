/**
 * Turning a thrown value into a `RelayError` (docs/hub-design.md section 10's `thrown.ts`, for the
 * relay). Only the error's code is kept: a library's message may quote what it was given (a frame,
 * a path holding an identity), which must never reach the log.
 */
import { type RelayError, type RelayErrorKind, relayError } from "../errors.ts";

/** The error's own code, when the library gives one: `ENOENT`, `SQLITE_FULL`. */
export function thrownCode(thrown: unknown): string | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;
  const code: unknown = "code" in thrown ? thrown.code : undefined;
  if (typeof code === "string") return code;
  return "cause" in thrown && thrown.cause !== thrown ? thrownCode(thrown.cause) : undefined;
}

/** A `RelayError` of `kind` from `origin`: `what` failed, with the thrown value's code. */
export function errorFrom(
  kind: RelayErrorKind,
  origin: string,
  what: string,
  thrown: unknown,
): RelayError {
  const code = thrownCode(thrown);
  return code === undefined
    ? relayError(kind, origin, what)
    : relayError(kind, origin, what, { code });
}
