/** The only writer of the database while the hub runs (hub-design.md sections 3, 4 and 5). */
import type { Result } from "neverthrow";
import type { CadenceMs, Effect } from "../core/model/effects.ts";
import type { HubError } from "../core/model/errors.ts";
import type { DeviceId } from "../core/model/ids.ts";
import type { Mono } from "../core/model/time.ts";

export type StorageError = HubError & { readonly kind: "storage" };

/** A `write` or `record` effect, as the loop stages it. */
export type StagedEffect = Extract<Effect, { readonly kind: "write" | "record" }>;

/** Why a flush ran (section 5, "The writer flushes"). */
export type FlushReason = "now" | "due" | "size" | "cadence" | "log" | "stop";

/** What one commit did. */
export interface CommitInfo {
  readonly items: number;
  readonly durationMs: number;
}

/**
 * Staged items are applied in staging order (inserts kept in order, upserts kept by row); a
 * flush is one transaction with `synchronous = FULL`, holding everything staged, with the commit
 * mark. `flush` blocks for one SQLite commit. On failure nothing is half-written: the items stay
 * staged and the core gets `commit {failed}`; retries follow after 1, 2, 4, then every 10 s ‡.
 */
export interface Writer {
  stage(items: readonly StagedEffect[]): void;
  flush(reason: FlushReason): Result<CommitInfo, StorageError>;
  /** When the next routine or cadence flush is due, or undefined with nothing to flush. */
  due(now: Mono): Mono | undefined;
  /** The core's `cadence` effect: commit every second while a countdown or the alarm runs. */
  setCadence(everyMs: CadenceMs): void;
  /**
   * The highest committed resume point for a device key, for the send gate (section 4): a send
   * goes only if each of its counters is below this. Undefined for a key with none committed.
   * SPEC-QUESTION: section 3's sketch of `Writer` omits this and `setCadence`, which sections 4
   * and 5 need.
   */
  durable(device: DeviceId): number | undefined;
}
