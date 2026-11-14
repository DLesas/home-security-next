/**
 * Errors (hub-design.md section 10). Our own code never throws: every failure is a `HubError`
 * inside a neverthrow `Result`, and a failure of the core's own logic is a `CoreFault`.
 */
import type { CounterRejection, ErrorCode } from "@hsn/protocol";
import type { HubEvent } from "./events.ts";

export type HubErrorKind =
  "storage" | "link" | "codec" | "crypto" | "config" | "control" | "random" | "internal";

export interface HubError {
  readonly kind: HubErrorKind;
  /** Where it arose: "shell/storage/writer", "core/sirens". */
  readonly origin: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A failure of the core's own logic: `step` returns it and the shell keeps the state as it was
 * before the input, records the fault with the input's event kind, and goes on (section 10).
 */
export type CoreFault = HubError & { readonly kind: "internal"; readonly event: HubEvent["kind"] };

/** Builds a `CoreFault` for the input whose event kind is `event`. */
export function coreFault(
  event: HubEvent["kind"],
  origin: string,
  message: string,
  detail?: HubError["detail"],
): CoreFault {
  const fault = { kind: "internal", origin, message, event } as const;
  return detail === undefined ? fault : { ...fault, detail };
}

/**
 * Why a frame or packet was rejected, as counted in `rejects` (HB15, section 10): the
 * protocol's error codes, its two counter rejections, and the hub's own reasons.
 */
export type RejectReason =
  | ErrorCode
  | CounterRejection
  /** A valid header from an address the hub does not know; no AES is spent on it. */
  | "unknownAddress"
  /** A packet on a path its type does not use (§5, "Paths"). */
  | "wrongPath"
  /** A session-bound gateway packet with no session on its link. */
  | "noSession"
  /** A text message on a WebSocket link, which closes it with code 1003 (section 3). */
  | "textFrame"
  /**
   * A frame on a link the hub had closed. Only in lockstep, whose controller is not told of the
   * hub's closes (section 11) and may go on sending: such a frame is counted, never lost.
   */
  | "closedLink";
