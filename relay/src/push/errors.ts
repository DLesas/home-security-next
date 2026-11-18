/**
 * The push role's error, in the hub's style (docs/hub-design.md section 10): a kind, where it
 * came from, what failed. Every failure in `relay/src/push/` is one of these inside a neverthrow
 * result; nothing here throws.
 *
 * **No secret in an error.** A message names what failed and, at most, a library's error code. It
 * never holds a push token, an `h`, a JWT, an access token, a key or a credential file's text:
 * wrappers that touch those keep the thrown value's code and drop its message (`safe/thrown.ts`),
 * since a library's message may quote its input. Errors go to the log as they are.
 */

export type PushErrorKind =
  /** The command line or a setting. */
  | "config"
  /** A key or credential file: missing, readable by others, not of its kind. */
  | "credentials"
  /** Signing, or a key that `node:crypto` would not take. */
  | "crypto"
  /** A relay link or the listener. */
  | "link"
  /** Apple's or Google's service, or the way to it. */
  | "service";

export interface PushError {
  readonly kind: PushErrorKind;
  /** The file it came from: `push/apns`, `push/safe/http2`. */
  readonly origin: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export function pushError(
  kind: PushErrorKind,
  origin: string,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): PushError {
  return detail === undefined ? { kind, origin, message } : { kind, origin, message, detail };
}
