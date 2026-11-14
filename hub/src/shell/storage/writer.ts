/**
 * The one writer of the database while the hub runs (hub-design.md sections 3, 4 and 5). It
 * stages the core's `write` and `record` effects, and commits them, everything staged at once,
 * in one transaction with the commit mark, when one of section 5's rules says so:
 *
 * - at once, for anything staged "now" (section 4, step 3);
 * - five minutes after the first routine item entered an empty batch (D112);
 * - at 2,000 items or 512 KB ‡;
 * - every second while a countdown or the alarm runs (the core's `cadence` effect), even with
 *   only the commit mark to write;
 * - when `hsn log` asks, and at a clean stop, with the clean-stop mark.
 *
 * With nothing staged and nothing running, nothing is written. A failed commit keeps the batch,
 * tells the core (`takeOutcome`), and is retried after 1, 2, 4, then every 10 s ‡. It also keeps
 * the highest committed resume point of every device key, for the send gate (section 4), and runs
 * its own checkpoints, never before the sends that wait on a "now" commit.
 *
 * SPEC-QUESTION: section 5 counts the records dropped past 10,000 "in one event", but the writer
 * has no record sequence to write a hub event with; the count goes in the `commit {failed}`
 * outcome's message, which the audit module records.
 */
import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "neverthrow";
import type { CadenceMs } from "../../core/model/effects.ts";
import type { CommitOutcome, TrimReport } from "../../core/model/events.ts";
import { type BootId, type DeviceId, HUB_DEVICE } from "../../core/model/ids.ts";
import type { DeviceStateRow } from "../../core/model/rows.ts";
import type { HubRules } from "../../core/model/rules.ts";
import type { StoreOp } from "../../core/model/store.ts";
import { type Mono, monoAfterMs, type Now } from "../../core/model/time.ts";
import type { Clock } from "../../ports/clock.ts";
import type {
  CommitInfo,
  FlushReason,
  StagedEffect,
  StorageError,
  Writer,
} from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";
import { Batch } from "./batch.ts";
import { isDatabaseFull, pagesInUseBytes, trimRound } from "./size-guard.ts";
import { auditTableOf, bindRow, prune, type Statements } from "./statements.ts";
import { checkpoint, walFrames } from "./wal.ts";

const MB = 1024 * 1024;
const ORIGIN = "shell/storage/writer";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Retries of a failed flush: after 1, 2, 4, then every 10 s ‡ (section 5, "A failed flush"). */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 10_000];
/** A batch that passes 10,000 items while the database fails drops its oldest records (section 5). */
export const FAILING_BATCH_CAP = 10_000;
/** The writer checkpoints once the WAL holds 1,000 pages ‡ ... (section 5, `wal_autocheckpoint`). */
export const CHECKPOINT_FRAMES = 1_000;
/** ... or an hour ‡ has passed since the last. */
export const CHECKPOINT_EVERY_MS = HOUR_MS;
/** `PRAGMA optimize` runs daily, after a commit (section 5). */
export const OPTIMIZE_EVERY_MS = 24 * HOUR_MS;

/** What one commit did, beyond the port's `CommitInfo`. */
export interface WriterCommit extends CommitInfo {
  /** False when there was nothing to write, so no transaction ran. */
  readonly committed: boolean;
  readonly reason: FlushReason;
  /** WAL frames this commit appended, when the WAL index could be read. */
  readonly walFrames: number | undefined;
}

/** Counts for the write budget (section 11) and `hsn status`. */
export interface WriterStats {
  commits: number;
  readonly commitsByReason: Record<FlushReason, number>;
  /** WAL frames appended by commits, read from the WAL index after each. */
  walFrames: number;
  /** Commits whose frames could not be read. */
  walFramesUnknown: number;
  checkpoints: number;
  /** The `log` frame counts the checkpoints reported, each counted once. */
  checkpointedFrames: number;
  failures: number;
  droppedRecords: number;
}

export interface WriterOptions {
  readonly db: Database;
  /** The database file, for its WAL index. */
  readonly path: string;
  readonly pageSize: number;
  readonly statements: Statements;
  readonly clock: Clock;
  /** This run's boot: the commit mark's and the clean-stop mark's. */
  readonly boot: BootId;
  readonly rules: HubRules["persistence"];
  /** The resume points committed before this run, by device key. */
  readonly durable: ReadonlyMap<DeviceId, number>;
  /** Told every committed write, after its commit: the `KeyStore` applies `device_keys` (section 3). */
  readonly onCommitted?: (ops: readonly StoreOp[]) => void;
  /** Told every failed commit at once, for `fatal.log` (section 5, "A failed flush"). */
  readonly onFailed?: (error: StorageError) => void;
  /** Milliseconds, for a commit's duration only; lockstep gives one that reads no host clock. */
  readonly stopwatch?: () => number;
}

/** The commit mark: device 0's row of `device_state`, written in every commit (section 5). */
export function commitMark(boot: BootId, now: Now): DeviceStateRow {
  return {
    deviceId: HUB_DEVICE,
    boot,
    lastSeenMono: now.mono,
    lastSeenMs: now.wall,
    clockOk: now.wallTrusted,
    window: null,
    reading: null,
    rssi: null,
    snrQ: null,
    bestGatewayId: null,
    uptimeS: null,
    estimates: null,
  };
}

const NO_REASONS: Record<FlushReason, number> = {
  now: 0,
  due: 0,
  size: 0,
  cadence: 0,
  log: 0,
  stop: 0,
};

export class SqliteWriter implements Writer {
  readonly stats: WriterStats = {
    commits: 0,
    commitsByReason: { ...NO_REASONS },
    walFrames: 0,
    walFramesUnknown: 0,
    checkpoints: 0,
    checkpointedFrames: 0,
    failures: 0,
    droppedRecords: 0,
  };
  readonly #options: WriterOptions;
  readonly #batch = new Batch();
  readonly #durable: Map<DeviceId, number>;
  #cadence: CadenceMs;
  #lastCommitAt: Mono | undefined;
  #lastCommitMs: number | undefined;
  /** Consecutive failed flushes, and when the next may be tried. */
  #failures = 0;
  #retryAt: Mono | undefined;
  /** What the core must hear, in order (section 5 and section 6's size guard). */
  #outcomes: CommitOutcome[] = [];
  /** Whether the size guard is trimming: from past its upper mark until back under its lower. */
  #trimming = false;
  /** The pages in use after the last commit, in bytes. */
  #inUseBytes: number | undefined;
  /** Whether this trimming episode has said that nothing more can be trimmed. */
  #exhaustedSaid = false;
  /** Records dropped since the last outcome was taken. */
  #droppedSinceOutcome = 0;
  #frames: number | undefined;
  #walRestartPending = false;
  #commitsSinceCheckpoint = 0;
  #lastCheckpointAt: Mono;
  #lastOptimizeAt: Mono;
  #checkpointPending = false;

  constructor(options: WriterOptions) {
    this.#options = options;
    this.#durable = new Map(options.durable);
    this.#cadence = options.rules.routineBatchMs;
    const started = options.clock.now().mono;
    this.#lastCheckpointAt = started;
    this.#lastOptimizeAt = started;
    // What an earlier run or the migrations left in the WAL goes to the main file first, so the
    // counts start from an empty log; a failure here only leaves the first count unknown.
    this.#walRestartPending = checkpoint(options.db)
      .map((done) => done.checkpointed === done.log)
      .unwrapOr(false);
    this.#frames = walFrames(options.path, options.pageSize).unwrapOr(undefined);
  }

  /** Items staged and not yet committed. */
  get staged(): number {
    return this.#batch.size;
  }

  /** The pages in use after the last commit, for `hsn status`; undefined before the first. */
  get inUseBytes(): number | undefined {
    return this.#inUseBytes;
  }

  /** Whether history is being shortened to stay within the size guard's marks (section 6). */
  get trimming(): boolean {
    return this.#trimming;
  }

  /** The wall time of the last commit, for `hsn status` (section 9); undefined before the first. */
  get lastCommitMs(): number | undefined {
    return this.#lastCommitMs;
  }

  stage(items: readonly StagedEffect[]): void {
    if (items.length === 0) return;
    const at = this.#options.clock.now().mono;
    for (const item of items) this.#batch.stage(item, at);
    if (this.#failures > 0 && this.#batch.size > FAILING_BATCH_CAP) {
      const dropped = this.#batch.dropOldestRecords(FAILING_BATCH_CAP);
      this.stats.droppedRecords += dropped;
      this.#droppedSinceOutcome += dropped;
    }
  }

  setCadence(everyMs: CadenceMs): void {
    this.#cadence = everyMs;
  }

  durable(device: DeviceId): number | undefined {
    return this.#durable.get(device);
  }

  /** Why a flush is due at `now`, or undefined when none is. */
  dueReason(now: Mono): FlushReason | undefined {
    if (this.#retryAt !== undefined) {
      return this.#retryAt <= now && this.#hasWork() ? "due" : undefined;
    }
    if (this.#batch.hasNow) return "now";
    if (this.#overSize()) return "size";
    const routine = this.#routineDue();
    if (routine !== undefined && routine <= now) return "due";
    const cadence = this.#cadenceDue(now);
    return cadence !== undefined && cadence <= now ? "cadence" : undefined;
  }

  due(now: Mono): Mono | undefined {
    if (this.#retryAt !== undefined) return this.#hasWork() ? this.#retryAt : undefined;
    if (this.#batch.hasNow || this.#overSize()) return now;
    const routine = this.#routineDue();
    const cadence = this.#cadenceDue(now);
    if (routine === undefined || cadence === undefined) return routine ?? cadence;
    return cadence < routine ? cadence : routine;
  }

  /** Flushes when a rule says so at `now`; otherwise does nothing. */
  flushIfDue(now: Mono): Result<WriterCommit | undefined, StorageError> {
    const reason = this.dueReason(now);
    return reason === undefined ? ok(undefined) : this.flush(reason);
  }

  flush(reason: FlushReason): Result<WriterCommit, StorageError> {
    const items = this.#batch.items();
    const always = reason === "cadence" || reason === "stop";
    if (items.length === 0 && !always) {
      return ok({ items: 0, durationMs: 0, committed: false, reason, walFrames: 0 });
    }
    const now = this.#options.clock.now();
    const stopwatch = this.#options.stopwatch ?? (() => performance.now());
    const started = stopwatch();
    // Routine commits trim while trimming is on, inside their own transaction (section 6).
    const routine = reason === "due" || reason === "size" || reason === "cadence";
    const applied = this.#commit(items, now, reason === "stop", routine && this.#trimming);
    const durationMs = stopwatch() - started;
    if (applied.isErr()) return err(this.#failed(applied.error, now.mono));
    const frames = this.#committed(items, now.mono, reason);
    this.#guarded(applied.value);
    this.#lastCommitMs = now.wall;
    // A checkpoint that fails is tried again after the next commit; the commit itself stands.
    this.#checkpointPending =
      reason === "now" || this.#maybeCheckpoint(now.mono).isErr() || this.#checkpointPending;
    return ok({ items: items.length, durationMs, committed: true, reason, walFrames: frames });
  }

  /** A clean stop: everything staged, the commit mark and the clean-stop mark, in one commit. */
  stop(): Result<WriterCommit, StorageError> {
    return this.flush("stop");
  }

  /**
   * What the core must hear after a flush: `failed` after each failed one, `recovered` after the
   * first success after a failure (section 5). Taken once.
   */
  takeOutcome(): CommitOutcome | undefined {
    const outcome = this.#outcomes.shift();
    if (outcome?.kind === "failed") this.#droppedSinceOutcome = 0;
    return outcome;
  }

  /**
   * The writer's own upkeep, run by the loop after the turn's sends (section 4, step 5): the
   * checkpoint a "now" commit put off, and `PRAGMA optimize` once a day.
   */
  maintain(): Result<void, StorageError> {
    const now = this.#options.clock.now().mono;
    if (this.#checkpointPending) {
      this.#checkpointPending = false;
      const done = this.#maybeCheckpoint(now);
      if (done.isErr()) return done;
    }
    if (
      this.#lastCommitAt !== undefined &&
      now >= monoAfterMs(this.#lastOptimizeAt, OPTIMIZE_EVERY_MS)
    ) {
      this.#lastOptimizeAt = now;
      return sqlite(ORIGIN, "optimize", () => {
        this.#options.db.run("PRAGMA optimize");
      });
    }
    return ok(undefined);
  }

  /** A checkpoint now, whatever the WAL holds, counting it as the writer's own do. */
  checkpointNow(): Result<void, StorageError> {
    return this.#checkpoint(this.#options.clock.now().mono);
  }

  #hasWork(): boolean {
    return this.#batch.size > 0 || this.#cadence === this.#options.rules.runningCadenceMs;
  }

  #overSize(): boolean {
    const { flushItems, flushBytes } = this.#options.rules;
    return this.#batch.size >= flushItems || this.#batch.bytes >= flushBytes;
  }

  /** Five minutes after the first routine item entered the empty batch (D112). */
  #routineDue(): Mono | undefined {
    const since = this.#batch.routineSince;
    return since === undefined ? undefined : monoAfterMs(since, this.#options.rules.routineBatchMs);
  }

  /** A second after the last commit while a countdown or the alarm runs; otherwise never. */
  #cadenceDue(now: Mono): Mono | undefined {
    if (this.#cadence !== this.#options.rules.runningCadenceMs) return undefined;
    return this.#lastCommitAt === undefined ? now : monoAfterMs(this.#lastCommitAt, this.#cadence);
  }

  #commit(
    items: readonly StagedEffect[],
    now: Now,
    stop: boolean,
    trim: boolean,
  ): Result<{ readonly trimmed: TrimReport | undefined; readonly inUse: number }, StorageError> {
    const { db, statements, boot, pageSize } = this.#options;
    const guard = this.#options.rules.sizeGuard;
    // The rows' own stamps never go back (section 6): nor does the protected ages' reference.
    const referenceMs = Math.max(now.wall, this.#lastCommitMs ?? now.wall);
    return sqlite(ORIGIN, `commit ${items.length} items`, () =>
      db.transaction(() => {
        // Trimming first, so its freed pages take the batch at the hard stop.
        const trimmed = trim ? trimRound(db, guard, referenceMs, pageSize) : undefined;
        for (const item of items) apply(db, statements, item);
        statements.state.device_state.write.run(bindRow(commitMark(boot, now)));
        if (stop) statements.cleanStop.run({ id: boot, cleanStopMs: now.wall });
        return { trimmed, inUse: pagesInUseBytes(db, pageSize) };
      })(),
    );
  }

  /**
   * After a commit: what it trimmed goes to the core, and the marks turn trimming on above the
   * upper one and off below the lower one, so it never starts and stops around a single mark.
   */
  #guarded(done: { readonly trimmed: TrimReport | undefined; readonly inUse: number }): void {
    const guard = this.#options.rules.sizeGuard;
    this.#inUseBytes = done.inUse;
    const ending = this.#trimming && done.inUse < guard.stopBytes;
    if (done.trimmed !== undefined) {
      if (done.trimmed.routineRows + done.trimmed.eventRows > 0) {
        this.#outcomes.push({
          kind: "trimmed",
          report: { ...done.trimmed, inUseBytes: done.inUse },
        });
      } else if (!this.#exhaustedSaid && !ending) {
        // Everything left is protected: said once an episode, before the hard stop is reached.
        this.#exhaustedSaid = true;
        this.#outcomes.push({ kind: "trimExhausted", inUseBytes: done.inUse });
      }
    }
    if (ending) {
      this.#trimming = false;
      this.#exhaustedSaid = false;
      this.#outcomes.push({ kind: "trimEnded", inUseBytes: done.inUse });
    } else if (!this.#trimming && done.inUse > guard.startBytes) {
      this.#trimming = true;
    }
  }

  #failed(error: StorageError, now: Mono): StorageError {
    this.#failures += 1;
    this.stats.failures += 1;
    const delay = RETRY_DELAYS_MS[Math.min(this.#failures, RETRY_DELAYS_MS.length) - 1] ?? 0;
    this.#retryAt = monoAfterMs(now, delay);
    const dropped = this.#droppedSinceOutcome;
    // At the hard stop: the database is full, and trimming must free pages (section 6).
    const full = isDatabaseFull(error.message);
    if (full) this.#trimming = true;
    const said = full
      ? `the database is full (the size guard's hard stop, ${Math.round(this.#options.rules.sizeGuard.hardStopBytes / MB)} MB): ${error.message}`
      : error.message;
    const message = dropped === 0 ? said : `${said}; ${dropped} records dropped`;
    // One failure waiting to be told is enough: the newest replaces it.
    this.#outcomes = [
      ...this.#outcomes.filter((o) => o.kind !== "failed"),
      { kind: "failed", message, full },
    ];
    this.#options.onFailed?.(error);
    return error;
  }

  /** After a commit: the gate's resume points, the key store, the batch, the counts. */
  #committed(items: readonly StagedEffect[], now: Mono, reason: FlushReason): number | undefined {
    const ops: StoreOp[] = [];
    for (const item of items) {
      if (item.kind !== "write") continue;
      ops.push(item.op);
      const op = item.op;
      if (op.table !== "send_counters") continue;
      if (op.op === "upsert") this.#durable.set(op.row.deviceId, op.row.resumePoint);
      if (op.op === "delete") this.#durable.delete(op.key.deviceId);
    }
    this.#batch.clear();
    this.#lastCommitAt = now;
    // A failure not yet told is told as the recovery it became.
    if (this.#failures > 0)
      this.#outcomes = [
        ...this.#outcomes.filter((o) => o.kind !== "failed"),
        { kind: "recovered" },
      ];
    this.#failures = 0;
    this.#retryAt = undefined;
    this.stats.commits += 1;
    this.stats.commitsByReason[reason] += 1;
    this.#commitsSinceCheckpoint += 1;
    this.#options.onCommitted?.(ops);
    return this.#countFrames();
  }

  /** Frames the last commit appended: the WAL index's count, from zero after a reset. */
  #countFrames(): number | undefined {
    const read = walFrames(this.#options.path, this.#options.pageSize).unwrapOr(undefined);
    const before = this.#frames;
    this.#frames = read;
    if (read === undefined || before === undefined) {
      this.stats.walFramesUnknown += 1;
      return undefined;
    }
    const restarted = this.#walRestartPending || read < before;
    this.#walRestartPending = false;
    const written = restarted ? read : read - before;
    this.stats.walFrames += written;
    return written;
  }

  #maybeCheckpoint(now: Mono): Result<void, StorageError> {
    if (this.#commitsSinceCheckpoint === 0) return ok(undefined);
    const full = (this.#frames ?? 0) >= CHECKPOINT_FRAMES;
    const late = now >= monoAfterMs(this.#lastCheckpointAt, CHECKPOINT_EVERY_MS);
    return full || late ? this.#checkpoint(now) : ok(undefined);
  }

  #checkpoint(now: Mono): Result<void, StorageError> {
    const result = checkpoint(this.#options.db);
    if (result.isErr()) return err(result.error);
    this.#lastCheckpointAt = now;
    this.stats.checkpoints += 1;
    if (this.#commitsSinceCheckpoint > 0) this.stats.checkpointedFrames += result.value.log;
    this.#commitsSinceCheckpoint = 0;
    // A checkpoint that copied every frame lets the next commit start the WAL from its beginning.
    this.#walRestartPending = result.value.checkpointed === result.value.log;
    return ok(undefined);
  }
}

/** Applies one staged item inside the commit's transaction. */
function apply(db: Database, statements: Statements, item: StagedEffect): void {
  if (item.kind === "record") {
    statements.audit[auditTableOf(item.record)].run(bindRow(item.record.row));
    return;
  }
  const op = item.op;
  switch (op.op) {
    case "upsert": {
      const table = statements.state[op.table];
      table.clear?.run();
      table.write.run(bindRow(op.row));
      return;
    }
    case "delete":
      statements.state[op.table].remove.run(op.key === undefined ? {} : bindRow(op.key));
      return;
    case "prune":
      prune(db, op);
      return;
  }
}
