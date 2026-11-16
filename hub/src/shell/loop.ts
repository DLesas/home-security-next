/**
 * The hub's loop (hub-design.md section 4, "One turn of the loop"): it takes the inputs the
 * adapters queued, runs `step` on each, and performs the effects in section 4's order.
 *
 * 1. Take the waiting inputs, at most 64, in arrival order; stamp each with the time and 32 fresh
 *    random bytes, and run `step`. A `CoreFault` leaves the state as it was for that input; it is
 *    handed back as the next turn's first input, which the audit module records with the next
 *    number (section 10); more than 100 in an hour stop the hub for a restart ‡.
 * 2. Stage every `write` and `record` effect of the turn with the writer, in order, and hand each
 *    `record` to the control socket for `hsn log --follow` as it is staged.
 * 3. Flush when the writer is due: at once when anything "now" was staged. The commit's outcome,
 *    a failure or a recovery, is the core's next `commit` input.
 * 4. Perform the sends, closes, answers and advertisements in order, each send through the send
 *    gate. A send refused, at the gate or by its link, comes back as `sendFailed`. While the
 *    turn's "now" commit failed, nothing it justified leaves: its sends are held back and its
 *    answers wait for a commit that succeeds.
 * 5. The turn's file jobs (m2-design.md section 9), only after the commit that justifies them
 *    succeeded and after the turn's answers, so a backup holds every change of its step and an
 *    export's reply leaves before its chunks; each outcome is the core's next `fileReady`. A job
 *    that switches (`switchUpdate`, `switchRestore`) ends the hub: a clean stop and exit 70.
 *    Then one piece of each job still open, in the order they started (m2-design.md section 3,
 *    "Jobs in pieces, the loop's contract"), and another turn soon while any is: the inputs that
 *    came meanwhile are the next turn's, never kept waiting for a job's end. A stop aborts every
 *    open job, which gives no `fileReady`; every job's end, however it ends, is told to the file
 *    jobs (`ended`), which free its upload.
 * 6. The writer's own upkeep, then the one system timer for the earliest of the core's wake and
 *    the writer's flush deadline.
 *
 * M2's channel effects (`appSend`, `closeClient`, `closeConn`, `linkSecret`, `hubStatusRead`) and
 * `historyRead` go to the app side in step 4, held after a failed "now" commit exactly as
 * `respond` is.
 */
import type { Result } from "neverthrow";
import type { AuditRecord } from "../core/model/audit.ts";
import type { ControlReply } from "../core/model/control.ts";
import type { Effect, FileWork } from "../core/model/effects.ts";
import type { CoreFault, HubError } from "../core/model/errors.ts";
import {
  type CommitOutcome,
  type FileOutcome,
  type HubEvent,
  INPUT_ENTROPY_BYTES,
} from "../core/model/events.ts";
import type { CoreDeps } from "../core/model/handler.ts";
import type { JobId, RequestId } from "../core/model/ids.ts";
import type { HubState } from "../core/model/state.ts";
import { type Mono, monoAfterMs } from "../core/model/time.ts";
import type { Core } from "../core/step.ts";
import type { Advertiser } from "../ports/advertiser.ts";
import type { Clock } from "../ports/clock.ts";
import type { Links } from "../ports/links.ts";
import type { Random } from "../ports/random.ts";
import type {
  CommitInfo,
  FlushReason,
  StagedEffect,
  StorageError,
  Writer,
} from "../ports/writer.ts";
import type { JobDone } from "./backup/jobs.ts";
import { jobCall } from "./safe/job.ts";
import { admitSend } from "./storage/send-gate.ts";

const ORIGIN = "shell/loop";

/**
 * A file job that cannot finish within section 3's limit (20 ms ‡ a turn on a Pi 4), as the loop
 * drives it (m2-design.md section 3, "Jobs in pieces, the loop's contract"): one `next()` a turn,
 * each within the limit, `done` becoming the job's `fileReady`; `abort()` on a stop deletes its
 * temporary files and gives no `fileReady`.
 */
export interface JobPieces {
  next(): { readonly done: false } | { readonly done: true; readonly outcome: FileOutcome };
  abort(): void;
}

/** What starting a file job gives the loop: done at once, a switch, or pieces to continue. */
export type JobStarted = JobDone | { readonly kind: "pieces"; readonly pieces: JobPieces };

/** A job that threw, as the core is told it: a failed job, like any other. */
function thrownOutcome(error: HubError): FileOutcome {
  return { kind: "failed", reason: "io", message: error.message };
}

/**
 * M2's effects the app side performs (`AppSide.perform`): the channel's, and `historyRead`, the
 * history page the shell reads and answers on the session (m2-design.md section 7).
 */
export type ChannelEffect = Extract<
  Effect,
  {
    readonly kind:
      "appSend" | "closeClient" | "closeConn" | "linkSecret" | "hubStatusRead" | "historyRead";
  }
>;

/** Commit outcomes one turn hands the core; any more wait for the next turn. */
const MAX_OUTCOMES_PER_TURN = 4;
/** Inputs one turn takes (section 4, step 1). */
export const MAX_INPUTS_PER_TURN = 64;
/** More core faults than this in an hour stop the hub for a restart ‡ (section 10). */
export const MAX_FAULTS_PER_HOUR = 100;
const HOUR_MS = 3_600_000;

/** What the loop needs of the writer: the port, with its flush rules and outcome. */
export interface LoopWriter extends Writer {
  flushIfDue(
    now: Mono,
  ): Result<(CommitInfo & { readonly committed: boolean }) | undefined, StorageError>;
  takeOutcome(): CommitOutcome | undefined;
  maintain(): Result<void, StorageError>;
  flush(reason: FlushReason): Result<CommitInfo & { readonly committed: boolean }, StorageError>;
}

/** The ports the loop drives. */
export interface LoopPorts {
  readonly clock: Clock;
  readonly random: Random;
  readonly links: Links;
  readonly control: {
    respond(request: RequestId, reply: ControlReply): void;
    /** Every record as it is staged, for `--follow` (section 9). */
    publish(record: AuditRecord): void;
  };
  readonly writer: LoopWriter;
  readonly advertiser: Advertiser;
  /** Sets the one system timer for `at`, replacing the last; none when undefined. */
  readonly wakeAt: (at: Mono | undefined) => void;
  /** Asks for another turn soon: inputs are still waiting. */
  readonly soon: () => void;
  /** An error the loop recorded, for `fatal.log` and standard error. */
  readonly report: (error: HubError) => void;
  /** The hub must stop: random bytes failed, or too many faults (section 10). */
  readonly fatal: (error: HubError) => void;
  /** The app channel (m2-design.md section 5); without it, its effects are reported. */
  readonly channel?: { perform(effect: ChannelEffect): void };
  /** The file jobs (section 9); without them, `fileJob` is reported. */
  readonly files?: {
    perform(job: JobId, work: FileWork): JobStarted;
    /** A job has ended, done, failed, thrown or aborted: its upload is freed (section 3). */
    ended?(job: JobId, work: FileWork, outcome: FileOutcome | undefined): void;
  };
  /**
   * A switching job's end: stop cleanly, run `afterStop` once the database is closed, and exit
   * 70 for the launcher (section 9).
   */
  readonly restart?: (afterStop: () => Result<void, string>) => void;
  /** Each commit's records, once committed: the healthy mark watches for `update_healthy`. */
  readonly committed?: (records: readonly AuditRecord[]) => void;
  /**
   * Milliseconds on a monotonic clock, for each turn's own time (section 3's limit per turn):
   * `performance.now` in the running hub, fixed in lockstep and tests. Never the core's clock.
   * Without it every turn takes 0 ms.
   */
  readonly stopwatch?: () => number;
}

/** What one turn did, for tests and the budget. */
export interface TurnSummary {
  readonly inputs: number;
  readonly faults: readonly CoreFault[];
  readonly effects: readonly Effect[];
  readonly committed: boolean;
  /** How long the turn held the loop, by the stopwatch (section 3). */
  readonly durationMs: number;
}

export class HubLoop {
  readonly #core: Core;
  readonly #deps: CoreDeps;
  readonly #ports: LoopPorts;
  #state: HubState;
  readonly #queue: HubEvent[] = [];
  /**
   * What a failed "now" commit holds back, in order, until a commit succeeds (section 4): answers,
   * the channel's effects and file jobs.
   */
  #held: (
    | { readonly kind: "respond"; readonly request: RequestId; readonly reply: ControlReply }
    | { readonly kind: "channel"; readonly effect: ChannelEffect }
    | { readonly kind: "fileJob"; readonly job: JobId; readonly work: FileWork }
  )[] = [];
  #failing = false;
  #faultTimes: Mono[] = [];
  #stopped = false;
  /** The longest turn since boot or since it was last read (`takeLongestTurnMs`). */
  #longestTurnMs = 0;
  /** The jobs in pieces still open, in the order they started. */
  #open: { readonly job: JobId; readonly work: FileWork; readonly pieces: JobPieces }[] = [];

  constructor(core: Core, deps: CoreDeps, ports: LoopPorts, state: HubState = core.emptyState()) {
    this.#core = core;
    this.#deps = deps;
    this.#ports = ports;
    this.#state = state;
  }

  get state(): HubState {
    return this.#state;
  }

  /** Inputs waiting for the next turn. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** An adapter's event: queued for the next turn, in arrival order. */
  enqueue(event: HubEvent): void {
    if (this.#stopped) return;
    this.#queue.push(event);
    this.#ports.soon();
  }

  /** The longest turn since boot or the last read, in milliseconds; reading it starts again. */
  takeLongestTurnMs(): number {
    const longest = this.#longestTurnMs;
    this.#longestTurnMs = 0;
    return longest;
  }

  /** Jobs in pieces still open. */
  get openJobs(): number {
    return this.#open.length;
  }

  /** The loop takes nothing more (a clean stop or a fatal error); every open job is aborted. */
  stop(): void {
    this.#stopped = true;
    const open = this.#open;
    this.#open = [];
    for (const { job, work, pieces } of open) {
      const aborted = jobCall(ORIGIN, `abort file job ${String(job)}`, () => {
        pieces.abort();
      });
      if (aborted.isErr()) this.#ports.report(aborted.error);
      this.#ended(job, work, undefined);
    }
  }

  /** One turn (section 4). */
  turn(): TurnSummary {
    const { clock, writer, control } = this.#ports;
    const stopwatch = this.#ports.stopwatch ?? (() => 0);
    const startedMs = stopwatch();
    const inputs = this.#queue.splice(0, MAX_INPUTS_PER_TURN);
    const effects: Effect[] = [];
    const faults: CoreFault[] = [];
    for (const event of inputs) {
      const entropy = this.#ports.random.bytes(INPUT_ENTROPY_BYTES);
      if (entropy.isErr()) {
        this.#ports.fatal(entropy.error);
        this.stop();
        break;
      }
      const now = clock.now();
      const result = this.#core.step(
        this.#state,
        { now, entropy: entropy.value, event },
        this.#deps,
      );
      if (result.isOk()) {
        this.#state = result.value.state;
        effects.push(...result.value.effects);
        continue;
      }
      faults.push(result.error);
      this.#ports.report(result.error);
      // The fault goes back to the core as the next input, so the audit module records it with
      // the next number, in time order (section 6). A fault on that input is reported only.
      this.#countFault(now.mono);
      const fault = result.error;
      const again = event.kind === "inputRejected" && event.rejection.source === "core";
      if (!again && !this.#stopped) {
        this.#queue.unshift({
          kind: "inputRejected",
          rejection: {
            source: "core",
            event: fault.event,
            origin: fault.origin,
            message: fault.message,
            detail: fault.detail ?? {},
          },
        });
      }
    }

    // Step 2: stage, publishing each record for --follow as it is staged.
    const staged: StagedEffect[] = [];
    for (const effect of effects) {
      if (effect.kind === "write" || effect.kind === "record") staged.push(effect);
      if (effect.kind === "cadence") writer.setCadence(effect.everyMs);
    }
    writer.stage(staged);
    for (const item of staged) if (item.kind === "record") control.publish(item.record);

    // Step 3: flush when due; at once for anything "now".
    const needsNow = staged.some((item) => item.durability === "now");
    const flushed = writer.flushIfDue(clock.now().mono);
    if (flushed.isErr()) {
      this.#failing = true;
      this.#ports.report(flushed.error);
    } else if (flushed.value?.committed === true) {
      this.#failing = false;
      this.#ports.committed?.(
        staged.flatMap((item) => (item.kind === "record" ? [item.record] : [])),
      );
    }
    const committed = !(needsNow && flushed.isErr());
    // Each outcome the commit had (a failure or recovery, what the size guard trimmed): bounded.
    for (let taken = 0; taken < MAX_OUTCOMES_PER_TURN; taken++) {
      const outcome = writer.takeOutcome();
      if (outcome === undefined) break;
      this.#queue.push({ kind: "commit", outcome });
    }

    // Step 4: the turn's sends, closes, answers and advertisements, in order.
    const jobs: { readonly job: JobId; readonly work: FileWork }[] = [];
    if (!this.#failing) this.#releaseHeld(jobs);
    for (const effect of effects) {
      if (effect.kind === "fileJob") {
        if (committed && !this.#failing) jobs.push({ job: effect.job, work: effect.work });
        else this.#held.push({ kind: "fileJob", job: effect.job, work: effect.work });
      } else this.#perform(effect, committed);
    }

    // Step 5: the file jobs, after the commit and the answers; then a piece of each open one.
    for (const { job, work } of jobs) this.#runJob(job, work);
    this.#runPieces();

    // Step 6: upkeep, then the one timer.
    const upkeep = writer.maintain();
    if (upkeep.isErr()) this.#ports.report(upkeep.error);
    this.#arm();
    if (this.#queue.length > 0 || this.#open.length > 0) this.#ports.soon();
    const durationMs = Math.max(0, stopwatch() - startedMs);
    if (durationMs > this.#longestTurnMs) this.#longestTurnMs = durationMs;
    return { inputs: inputs.length, faults, effects, committed, durationMs };
  }

  /** The earliest of the core's wake and the writer's flush deadline (section 4, step 5). */
  nextWake(): Mono | undefined {
    const now = this.#ports.clock.now().mono;
    const wakes = [this.#core.nextDeadline(this.#state), this.#ports.writer.due(now)].filter(
      (at) => at !== undefined,
    );
    return wakes.length === 0 ? undefined : wakes.reduce((a, b) => (b < a ? b : a));
  }

  #arm(): void {
    this.#ports.wakeAt(this.nextWake());
  }

  #releaseHeld(jobs: { readonly job: JobId; readonly work: FileWork }[]): void {
    const held = this.#held;
    this.#held = [];
    for (const item of held) {
      if (item.kind === "respond") this.#ports.control.respond(item.request, item.reply);
      else if (item.kind === "channel") this.#ports.channel?.perform(item.effect);
      else jobs.push({ job: item.job, work: item.work });
    }
  }

  #runJob(job: JobId, work: FileWork): void {
    const files = this.#ports.files;
    if (files === undefined) {
      this.#ports.report({
        kind: "internal",
        origin: ORIGIN,
        message: "the fileJob effect has no file jobs to run it",
      });
      return;
    }
    // A job after a switch in the same turn is not started: the hub is stopping.
    if (this.#stopped) {
      this.#ended(job, work, undefined);
      return;
    }
    const started = jobCall(ORIGIN, `start file job ${String(job)}`, () =>
      files.perform(job, work),
    );
    if (started.isErr()) {
      this.#ports.report(started.error);
      this.#ready(job, work, thrownOutcome(started.error));
      return;
    }
    const done = started.value;
    if (done.kind === "ready") {
      this.#ready(job, work, done.outcome);
      return;
    }
    if (done.kind === "pieces") {
      this.#open.push({ job, work, pieces: done.pieces });
      return;
    }
    // A switch ends the hub: nothing more is taken, and the caller stops cleanly and exits 70.
    this.#ended(job, work, undefined);
    this.stop();
    this.#ports.restart?.(done.afterStop);
  }

  /** One piece of each open job, in the order they started (section 3). */
  #runPieces(): void {
    for (const open of [...this.#open]) {
      if (this.#stopped) return;
      const piece = jobCall(ORIGIN, `continue file job ${String(open.job)}`, () =>
        open.pieces.next(),
      );
      let outcome: FileOutcome;
      if (piece.isErr()) {
        this.#ports.report(piece.error);
        outcome = thrownOutcome(piece.error);
      } else if (piece.value.done) outcome = piece.value.outcome;
      else continue;
      this.#open = this.#open.filter((o) => o !== open);
      this.#ready(open.job, open.work, outcome);
    }
  }

  #ready(job: JobId, work: FileWork, outcome: FileOutcome): void {
    this.#queue.push({ kind: "fileReady", job, outcome });
    this.#ended(job, work, outcome);
  }

  #ended(job: JobId, work: FileWork, outcome: FileOutcome | undefined): void {
    const ended = jobCall(ORIGIN, `end file job ${String(job)}`, () => {
      this.#ports.files?.ended?.(job, work, outcome);
    });
    if (ended.isErr()) this.#ports.report(ended.error);
  }

  #perform(effect: Effect, committed: boolean): void {
    const { links, control, advertiser, writer } = this.#ports;
    switch (effect.kind) {
      case "write":
      case "record":
      case "cadence":
        return;
      case "send": {
        const admitted = admitSend(writer, effect.counters, committed);
        if (admitted.isErr()) {
          this.#queue.push({
            kind: "sendFailed",
            link: effect.link,
            ref: effect.ref,
            error: "notDurable",
          });
          return;
        }
        const sent = links.send(effect.link, effect.bytes, effect.ref);
        if (sent.isErr()) {
          this.#queue.push({
            kind: "sendFailed",
            link: effect.link,
            ref: effect.ref,
            error: sent.error.code,
          });
        }
        return;
      }
      case "close": {
        const closed = links.close(effect.link, effect.reason);
        if (closed.isErr()) this.#ports.report(closed.error);
        return;
      }
      case "respond":
        if (committed && !this.#failing) control.respond(effect.request, effect.reply);
        else this.#held.push({ kind: "respond", request: effect.request, reply: effect.reply });
        return;
      case "advertise": {
        const advertised = advertiser.advertise(effect.identity, effect.port);
        if (advertised.isErr()) this.#ports.report(advertised.error);
        return;
      }
      // M2's channel effects (m2-design.md section 5), held after a failed commit as answers are.
      case "appSend":
      case "closeClient":
      case "closeConn":
      case "linkSecret":
      case "hubStatusRead":
      case "historyRead":
        // `historyRead`, `history.query`'s page (section 7), is read and answered by the app side.
        if (this.#ports.channel === undefined) {
          this.#notBuilt(effect.kind);
          return;
        }
        if (committed && !this.#failing) this.#ports.channel.perform(effect);
        else this.#held.push({ kind: "channel", effect });
        return;
      case "fileJob":
        return;
    }
  }

  #notBuilt(kind: string): void {
    this.#ports.report({
      kind: "internal",
      origin: "shell/loop",
      message: `the ${kind} effect is not built yet (m2-design.md section 11, step 2)`,
    });
  }

  #countFault(at: Mono): void {
    const since = monoAfterMs(at, -HOUR_MS);
    this.#faultTimes = [...this.#faultTimes.filter((t) => t >= since), at];
    if (this.#faultTimes.length > MAX_FAULTS_PER_HOUR) {
      this.#ports.fatal({
        kind: "internal",
        origin: "shell/loop",
        message: `more than ${MAX_FAULTS_PER_HOUR} core faults within an hour`,
      });
      this.stop();
    }
  }
}
