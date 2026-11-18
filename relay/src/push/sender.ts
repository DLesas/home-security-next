/**
 * `PushSender` (docs/m4-design.md section 5, "To Apple and Google"): the operated relay's side
 * of its relay link to the push service (D142). Every relay, the operated one included, reaches
 * the push service over `/v1/relay`; the operated relay through a local socket only its account
 * can open. The relay role calls it with the items its hubs' `push` frames resolved through their
 * rosters; the push service answers each item with an outcome. Frozen by the joint step 0;
 * B3 implements it over the relay link, B2's relay core calls it.
 */
import type { ResultAsync } from "neverthrow";
import type { PushOutcome, RelayPushItem } from "@hsn/protocol/relay";

/** One item's outcome, by the item's `id` (the relay's own number for it on that link). */
export interface PushSendResult {
  readonly id: number;
  readonly outcome: PushOutcome;
}

/** Why a whole batch could not be handed over: nothing in it was sent. */
export type PushSendError =
  /** The relay link is not up (not yet joined, closed, or waiting out a back-off). */
  | { readonly kind: "linkDown" }
  /** The push service answered `limit` for this relay key: wait `retryAfterMs`. */
  | { readonly kind: "limited"; readonly retryAfterMs: number }
  /** No `pushResult` for the batch within the link's time. */
  | { readonly kind: "timeout" };

export interface PushSender {
  /**
   * Sends at most `RELAY_LIMITS.maxPushItemsPerFrame` items in one `push` frame and resolves with
   * one result per item, in any order, once the push service's `pushResult` arrives. Never
   * rejects: every failure is a `PushSendError`, after which the caller treats each item as
   * `failed` and retries as section 4's outbox does.
   */
  send(items: readonly RelayPushItem[]): ResultAsync<readonly PushSendResult[], PushSendError>;
  /** Whether the relay link is joined now. */
  readonly up: boolean;
}
