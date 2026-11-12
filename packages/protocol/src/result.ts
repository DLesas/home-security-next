/**
 * Why decoding or opening failed. A closed set, so callers can switch on it and log it.
 * No error ever carries key bytes or decrypted content.
 */
export type ErrorCode =
  /** The input ended before every required field. */
  | "truncated"
  /** The input is longer than the size limit in force. */
  | "tooLong"
  /** A protocol or format version this code does not support. */
  | "badVersion"
  /** A packet whose direction bit is not the one the receiver expects. */
  | "wrongDirection"
  /** A device address of 0 or 0xFFFFFFFF, which are never given out. */
  | "badAddress"
  /** A packet counter of 0, which is never sent. */
  | "badCounter"
  /** The authentication tag did not verify. */
  | "badTag"
  /** A message type this code does not know; see `messageType`. */
  | "unknownType"
  /** A length prefix larger than its field allows. */
  | "badLength"
  /** A byte outside the values its field allows. */
  | "badValue"
  /** A USB frame that is not valid COBS. */
  | "badFrame"
  /** No counter is left to send with this key. */
  | "counterExhausted";

/** A decoding or opening failure. Only `unknownType` carries detail: the type byte, safe to log. */
export type ProtocolError =
  | { readonly code: "unknownType"; readonly messageType: number }
  | { readonly code: Exclude<ErrorCode, "unknownType"> };

/** The outcome of anything that reads untrusted bytes. Such functions never throw. */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ProtocolError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: Exclude<ErrorCode, "unknownType">): Result<T> {
  return { ok: false, error: { code } };
}

export function failUnknownType<T = never>(messageType: number): Result<T> {
  return { ok: false, error: { code: "unknownType", messageType } };
}
