/**
 * The test world's writer (hub-design.md sections 4, 5 and 11): it keeps what a real writer
 * would commit, without a database. Items are staged in order; a commit takes everything
 * staged. It commits at once when a "now" item is staged, and otherwise one cadence after the
 * first item entered an empty batch: five minutes, or a second under the core's `cadence`
 * effect. It has no commit mark, so with nothing staged it commits nothing. It keeps the
 * committed resume point of every device key, for the send gate.
 */
import type { CadenceMs } from "../../src/core/model/effects.ts";
import type { DeviceId } from "../../src/core/model/ids.ts";
import { type Mono, monoAfterMs } from "../../src/core/model/time.ts";
import type { StagedEffect } from "../../src/ports/writer.ts";

/** One commit: its time and the items it held, in staging order. */
export interface Commit {
  readonly at: Mono;
  readonly items: readonly StagedEffect[];
}

export class RecordingWriter {
  readonly commits: Commit[] = [];
  #staged: StagedEffect[] = [];
  #batchStarted: Mono | undefined;
  #cadence: CadenceMs;
  readonly #durable = new Map<DeviceId, number>();

  constructor(routineBatchMs: CadenceMs) {
    this.#cadence = routineBatchMs;
  }

  /** Items staged and not yet committed. */
  get staged(): readonly StagedEffect[] {
    return this.#staged;
  }

  /** Stages items; true when one of them must be committed now. */
  stage(items: readonly StagedEffect[], now: Mono): boolean {
    if (items.length > 0 && this.#staged.length === 0) this.#batchStarted = now;
    this.#staged.push(...items);
    return items.some((item) => item.durability === "now");
  }

  setCadence(everyMs: CadenceMs): void {
    this.#cadence = everyMs;
  }

  /** When the staged batch is due, or undefined with nothing staged. */
  due(): Mono | undefined {
    return this.#batchStarted === undefined
      ? undefined
      : monoAfterMs(this.#batchStarted, this.#cadence);
  }

  /** Commits everything staged. */
  flush(now: Mono): void {
    if (this.#staged.length === 0) return;
    for (const item of this.#staged) {
      if (item.kind === "write" && item.op.table === "send_counters" && item.op.op === "upsert") {
        this.#durable.set(item.op.row.deviceId, item.op.row.resumePoint);
      }
    }
    this.commits.push({ at: now, items: this.#staged });
    this.#staged = [];
    this.#batchStarted = undefined;
  }

  /** The highest committed resume point of a device key (section 4). */
  durable(device: DeviceId): number | undefined {
    return this.#durable.get(device);
  }
}
