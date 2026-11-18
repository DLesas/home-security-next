/**
 * The relay's error, in the hub's style (docs/hub-design.md section 10): a kind, where it came
 * from, what failed. Every failure in the relay's shell and releases role is one of these inside
 * a neverthrow result; nothing outside a `safe/` folder throws.
 *
 * **No identity, address or content in an error.** A message names what failed and, at most, a
 * library's error code; the wrappers keep a thrown value's code and drop its message, since a
 * library's message may quote its input (a path holding nothing private is the one exception).
 */

export type RelayErrorKind =
  /** The command line or the configuration file. */
  | "config"
  /** SQLite. */
  | "storage"
  /** A listener or a socket. */
  | "link"
  /** Randomness or a key. */
  | "crypto"
  /** The release folder, a release file, or the upstream it is filled from. */
  | "releases";

export interface RelayError {
  readonly kind: RelayErrorKind;
  /** The file it came from: `shell/storage/store`, `releases/folder-index`. */
  readonly origin: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export function relayError(
  kind: RelayErrorKind,
  origin: string,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): RelayError {
  return detail === undefined ? { kind, origin, message } : { kind, origin, message, detail };
}
