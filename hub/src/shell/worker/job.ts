/**
 * A file job as the loop's job, with the job itself on a worker thread (D145; the product owner's
 * ruling of 2026-11-20; the worker's side is `serve.ts`, its one entry `entry.ts`). On Windows one
 * file create, write or close can wait for hundreds of milliseconds (measured on the hosted
 * runners, worst with the antivirus scanning), and on the loop that was a door report's wait. A
 * kind of job gives what is its own (`WorkerJobKind`); the rest is here, the same for every kind.
 *
 * - **The loop's call is short.** The worker runs the job's pieces to the end on its own thread;
 *   the loop's `next()` only reads whether the outcome has come, and looks at `wanted`. While no
 *   outcome has come the job says it is waiting, so the loop asks no turn for it, and the
 *   outcome's arrival asks for one (`wake`); the outcome becomes the job's `fileReady` on the
 *   loop's own turn, so the core sees one order of events, as before.
 * - **A cancel** (the core no longer wants it, looked at on every turn, for a kind that has
 *   `wanted`): the worker is told and sees it before its next piece, and the job removes what it
 *   wrote. Whatever the worker ended with, a job the core no longer wants when its outcome is
 *   taken ends cancelled, with nothing left: what the worker had already put in place before it
 *   was told (`placed`) is removed first, off the loop. On the loop the cancel was seen one piece
 *   earlier; the core cannot tell the two apart. When the worker has not answered within
 *   `CANCEL_WAIT_MS` ‡ (it is in a file call), what it left (`leftovers`) is removed off the loop
 *   and the job ends; the worker ends on its own once the call returns.
 * - **A stop** (`abort`): the worker is told and waited for, at most `STOP_WAIT_MS` ‡, so that what
 *   it wrote is gone before the hub exits; that wait is the job's only one, and the loop is
 *   stopping. A worker still in a file call then is ended by the hub's exit, and the kind's next
 *   job removes what it left. An abort gives the core no outcome.
 * - **A worker that does not start, throws or exits first** ends the job failed `io`, saying so,
 *   once what it left is removed, off the loop.
 * - **One at a time, where a kind says so** (`gate`): a kind's jobs that share temporary files
 *   run one at a time. A job started before an earlier one of its gate is over (its outcome taken
 *   or its abort done, its thread gone, what it left removed) waits for it, at most
 *   `QUEUE_WAIT_MS` ‡, then fails `io`. Jobs of other gates, or of none, run beside it, as the
 *   loop runs one piece of every open job a turn.
 */
import { rm } from "node:fs/promises";
import { ResultAsync, type Result } from "neverthrow";
import type { FileOutcome } from "../../core/model/events.ts";
import { type JobThreadEvents, startJobThread } from "../safe/job-thread.ts";
import { JOB_CANCEL, JOB_STOP, jobControl, type JobControl } from "./control.ts";

/**
 * How long a stop waits for the worker to end and remove what it wrote ‡: a piece's longest wait
 * measured on Windows with each staged file synced, 1.8 s (hosted, Defender on, a 112 MB program;
 * run 44924085827), and room. A stop that waits it out leaves its files for the kind's next job,
 * and stays well within the launcher's 15 s and the Windows service's 30 s for a stop.
 */
export const STOP_WAIT_MS = 4000;
/** How long a cancel waits for the worker before ending the job ‡. */
export const CANCEL_WAIT_MS = 10_000;
/** How long a job waits for an earlier one of its gate to be over ‡. */
export const QUEUE_WAIT_MS = 10_000;

/** What starts a job's worker: the real thread but in a test. */
export type StartWorker = (data: WorkerData, events: JobThreadEvents) => Result<void, string>;

/** What the worker is started with: the kind's data and the shared word. */
export interface WorkerData {
  readonly kind: string;
  readonly control: JobControl;
  readonly [field: string]: unknown;
}

/** What a kind of job gives the mechanism. */
export interface WorkerJobKind {
  /** The job, in a word, for its outcomes' messages: "staging" ("the staging worker did not start"). */
  readonly name: string;
  /** The kind's jobs sharing it run one at a time (they share temporary files); undefined: none. */
  readonly gate: string | undefined;
  /** The worker's data but the control word: data only, as a worker's `workerData` must be. */
  readonly data: { readonly kind: string; readonly [field: string]: unknown };
  /** Whether the core still wants the job, asked on every turn; undefined: always. */
  readonly wanted?: () => boolean;
  /** A cancel's outcome message. */
  readonly cancelled: string;
  /** What a worker given up or ended without an outcome may have left; undefined: nothing. */
  readonly leftovers: () => Promise<readonly string[]> | undefined;
  /** What an outcome the core no longer wants left in place, removed before the job ends. */
  readonly placed: (outcome: FileOutcome) => readonly string[];
}

export interface WorkerJobOptions {
  /** Asks the loop for a turn: the outcome has come. Without it the job never says it waits. */
  readonly wake?: () => void;
  /** Starts the worker: the real one but in a test. */
  readonly start?: StartWorker;
  readonly stopWaitMs?: number;
  readonly cancelWaitMs?: number;
  readonly queueWaitMs?: number;
}

interface Gate {
  busy: boolean;
  readonly queue: (() => void)[];
}

/** Each gate's one running job, until it is over, and the jobs waiting for it. */
const gates = new Map<string, Gate>();

function gateOf(name: string): Gate {
  const found = gates.get(name);
  if (found !== undefined) return found;
  const made: Gate = { busy: false, queue: [] };
  gates.set(name, made);
  return made;
}

/** Whether a gate's job is running or not yet over (its thread, its removals): for the tests. */
export function gateBusy(name: string): boolean {
  return gates.get(name)?.busy === true;
}

function failed(message: string): FileOutcome {
  return { kind: "failed", reason: "io", message };
}

/** Removes `paths`, off the loop; whatever happens, it settles. */
export function removed(paths: readonly string[]): Promise<void> {
  return ResultAsync.combine(
    paths.map((path) =>
      ResultAsync.fromPromise(rm(path, { recursive: true, force: true }), () => undefined),
    ),
  ).match(
    () => undefined,
    () => undefined,
  );
}

/** One file job on its worker thread, as the loop's job in pieces. */
export class WorkerJob {
  readonly #kind: WorkerJobKind;
  readonly #options: WorkerJobOptions;
  readonly #gate: Gate | undefined;
  readonly #control = jobControl();
  #phase: "queued" | "running" | "over" = "queued";
  #cancelling = false;
  /** What the worker ended with, once it has (or what stands for it). */
  #outcome: FileOutcome | undefined;
  /** What the loop is given: once set, every `next()` returns it. */
  #taken: FileOutcome | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queued: (() => void) | undefined;
  /** Why the worker gave no outcome, once it has said so. */
  #why: string | undefined;
  /** Removals off the loop not yet done: the job is not over until they are. */
  #removing = 0;
  #exited = false;
  /** This job holds its gate (it began), until it is over. */
  #holdsGate = false;

  constructor(kind: WorkerJobKind, options: WorkerJobOptions = {}) {
    this.#kind = kind;
    this.#options = options;
    this.#gate = kind.gate === undefined ? undefined : gateOf(kind.gate);
    const gate = this.#gate;
    if (gate?.busy !== true) {
      this.#begin();
      return;
    }
    const begin = (): void => {
      this.#begin();
    };
    this.#queued = begin;
    gate.queue.push(begin);
    this.#timer = setTimeout(() => {
      this.#unqueue();
      this.#exited = true;
      this.#endWith(failed(`an earlier ${kind.name} has not yet ended`));
    }, options.queueWaitMs ?? QUEUE_WAIT_MS);
  }

  /**
   * Nothing for the loop to do until the outcome comes or a removal ends, either of which asks for
   * a turn itself (the turn a cancel comes in runs `next()` anyway).
   */
  waiting(): boolean {
    return (
      this.#taken === undefined &&
      this.#options.wake !== undefined &&
      (this.#outcome === undefined || this.#removing > 0)
    );
  }

  /** The outcome once the job has ended; undefined while the worker works. */
  next(): FileOutcome | undefined {
    if (this.#taken !== undefined) return this.#taken;
    if (this.#removing > 0) return undefined;
    const outcome = this.#outcome;
    if (this.#wanted()) return outcome === undefined ? undefined : this.#take(outcome);
    if (outcome === undefined) {
      this.#cancel();
      return this.#outcome === undefined ? undefined : this.#take(this.#outcome);
    }
    // Unwanted when it ended: cancelled, and what was already in place removed first.
    const placed = this.#kind.placed(outcome);
    if (placed.length === 0) return this.#take(failed(this.#kind.cancelled));
    this.#outcome = failed(this.#kind.cancelled);
    this.#removing += 1;
    void removed(placed).then(() => {
      this.#removing -= 1;
      if (this.#phase !== "over") this.#wake();
      this.#maybeRelease();
    });
    return undefined;
  }

  /** A stop: the worker told and waited for, within `STOP_WAIT_MS`; no outcome for the core. */
  abort(message: string): FileOutcome {
    const phase = this.#phase;
    this.#phase = "over";
    clearTimeout(this.#timer);
    this.#unqueue();
    if (phase === "queued") this.#exited = true;
    if (phase === "running" && this.#outcome === undefined) {
      Atomics.store(this.#control, 0, JOB_STOP);
      Atomics.wait(this.#control, 1, 0, this.#options.stopWaitMs ?? STOP_WAIT_MS);
    }
    this.#taken ??= failed(message);
    this.#maybeRelease();
    return this.#taken;
  }

  #wanted(): boolean {
    return this.#kind.wanted?.() !== false;
  }

  #begin(): void {
    this.#queued = undefined;
    clearTimeout(this.#timer);
    if (this.#gate !== undefined) {
      this.#gate.busy = true;
      this.#holdsGate = true;
    }
    this.#phase = "running";
    const started = (this.#options.start ?? startJobThread)(
      { ...this.#kind.data, control: this.#control },
      {
        ended: (outcome) => {
          this.#endWith(outcome);
        },
        failed: (why) => {
          this.#why = why;
        },
        exited: () => {
          this.#threadExited();
        },
      },
    );
    if (started.isErr()) {
      // Nothing ran, so nothing was written.
      this.#exited = true;
      this.#endWith(failed(`the ${this.#kind.name} worker did not start: ${started.error}`));
    }
  }

  #cancel(): void {
    if (this.#phase === "queued") {
      this.#unqueue();
      this.#exited = true;
      this.#endWith(failed(this.#kind.cancelled));
      return;
    }
    if (this.#phase !== "running" || this.#cancelling) return;
    this.#cancelling = true;
    Atomics.store(this.#control, 0, JOB_CANCEL);
    this.#timer = setTimeout(() => {
      // The worker is still in a file call: what it left removed off the loop. When the call
      // returns, it sees the cancel before its next piece and ends on its own.
      this.#removeLeftovers(failed(this.#kind.cancelled));
    }, this.#options.cancelWaitMs ?? CANCEL_WAIT_MS);
  }

  #threadExited(): void {
    this.#exited = true;
    const why = this.#why;
    if (why !== undefined && this.#outcome === undefined && this.#phase !== "over")
      this.#removeLeftovers(
        failed(`the ${this.#kind.name} worker ended without an outcome: ${why}`),
      );
    this.#maybeRelease();
  }

  /** The worker's end (or what stands for it), for the loop's next turn. */
  #endWith(outcome: FileOutcome): void {
    if (this.#outcome !== undefined) return;
    clearTimeout(this.#timer);
    this.#outcome = outcome;
    if (this.#phase !== "over") this.#wake();
    this.#maybeRelease();
  }

  /** Asks the loop for a turn, after whatever called in here has returned. */
  #wake(): void {
    const wake = this.#options.wake;
    if (wake !== undefined) queueMicrotask(wake);
  }

  #take(outcome: FileOutcome): FileOutcome {
    this.#taken = outcome;
    this.#phase = "over";
    this.#maybeRelease();
    return outcome;
  }

  /** What a worker left (`leftovers`), removed off the loop; then the job ends so. */
  #removeLeftovers(outcome: FileOutcome): void {
    const found = this.#kind.leftovers();
    if (found === undefined) {
      this.#endWith(outcome);
      return;
    }
    this.#removing += 1;
    void found.then(removed).then(() => {
      this.#removing -= 1;
      this.#endWith(outcome);
    });
  }

  #unqueue(): void {
    const queued = this.#queued;
    if (queued === undefined || this.#gate === undefined) return;
    this.#queued = undefined;
    const at = this.#gate.queue.indexOf(queued);
    if (at !== -1) this.#gate.queue.splice(at, 1);
  }

  /** The gate opened for the next job, once this one is over: taken or aborted, its thread gone, nothing being removed. */
  #maybeRelease(): void {
    const gate = this.#gate;
    if (gate === undefined || !this.#holdsGate) return;
    if (!this.#exited || this.#removing > 0 || this.#phase !== "over") return;
    this.#holdsGate = false;
    gate.busy = false;
    gate.queue.shift()?.();
  }
}
