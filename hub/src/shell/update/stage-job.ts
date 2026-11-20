/**
 * Staging an update as the loop's job, with the staging itself on a worker thread (the product
 * owner's ruling of 2026-11-20; the worker's side is `stage-serve.ts`). On Windows one file create
 * or close can wait for hundreds of milliseconds (measured on the hosted runners, worst with the
 * antivirus scanning), and on the loop that was a door report's wait.
 *
 * - **The loop's call is short.** The worker stages to the end on its own thread; the loop's
 *   `next()` only reads whether the outcome has come, and looks at `wanted`. While no outcome has
 *   come the job says it is waiting, so the loop asks no turn for it, and the outcome's arrival
 *   asks for one (`wake`); the outcome becomes the job's `fileReady` on the loop's own turn, so
 *   the core sees one order of events, as before.
 * - **A cancel** (the core no longer wants it, looked at on every turn): the worker is told and
 *   sees it before its next piece, and `Staging` removes its folder. Whatever the worker ended
 *   with, a staging the core no longer wants when its outcome is taken ends "staging was
 *   cancelled", with nothing left: a version the worker had already put in place before it was
 *   told is removed first, off the loop. On the loop the cancel was seen one piece earlier; the
 *   core cannot tell the two apart. When the worker has not answered within `CANCEL_WAIT_MS` ‡
 *   (it is in a file call), what it left is removed off the loop and the job ends; the worker
 *   ends on its own once the call returns, and the next staging waits for it.
 * - **A stop** (`abort`): the worker is told and waited for, at most `STOP_WAIT_MS` ‡, so that its
 *   folder is gone before the hub exits; that wait is the job's only one, and the loop is
 *   stopping. A worker still in a file call then is ended by the hub's exit, and the next
 *   staging's first pass removes what it left (`stage.ts`, `#hashPiece`). An abort gives the core
 *   no outcome.
 * - **A worker that does not start, throws or exits first** ends the job failed `io`, saying so,
 *   once what it wrote is removed, off the loop.
 * - **One staging at a time.** A staging started before an earlier one is over (its outcome
 *   taken or its abort done, its thread gone, what it left removed) waits for it, at most
 *   `QUEUE_WAIT_MS` ‡, then fails `io`: two would share the `.staging-*` folders.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";
import { installPaths } from "../../../launcher/src/layout.ts";
import type { FileOutcome } from "../../core/model/events.ts";
import { startStagingThread } from "../safe/staging-thread.ts";
import type { StageInputs } from "./stage.ts";
import { STAGING_CANCEL, STAGING_STOP, stagingControl } from "./stage-serve.ts";

/**
 * How long a stop waits for the worker to end and remove its folder ‡: a piece's longest wait
 * measured on Windows with each staged file synced, 1.8 s (hosted, Defender on, a 112 MB program;
 * run 44924085827), and room. A stop that waits it out leaves the folder for the next staging,
 * and stays well within the launcher's 15 s and the Windows service's 30 s for a stop.
 */
export const STOP_WAIT_MS = 4000;
/** How long a cancel waits for the worker before ending it ‡. */
export const CANCEL_WAIT_MS = 10_000;
/** How long a staging waits for an earlier one to be over ‡. */
export const QUEUE_WAIT_MS = 10_000;

export const CANCELLED = "staging was cancelled";

export interface StagingJobOptions {
  /** Asks the loop for a turn: the outcome has come. Without it the job never says it waits. */
  readonly wake?: () => void;
  /** Starts the worker: the real one but in a test. */
  readonly start?: typeof startStagingThread;
  readonly stopWaitMs?: number;
  readonly cancelWaitMs?: number;
  readonly queueWaitMs?: number;
}

/** The one staging that may be running, until it is over. */
const gate: { busy: boolean; readonly queue: (() => void)[] } = { busy: false, queue: [] };

/** Whether a staging is running or not yet over (its thread, its removals): for the tests. */
export function stagingBusy(): boolean {
  return gate.busy;
}

function failed(message: string): FileOutcome {
  return { kind: "failed", reason: "io", message };
}

/** Removes `paths`, off the loop; whatever happens, it settles. */
function removed(paths: readonly string[]): Promise<void> {
  return ResultAsync.combine(
    paths.map((path) =>
      ResultAsync.fromPromise(rm(path, { recursive: true, force: true }), () => undefined),
    ),
  ).match(
    () => undefined,
    () => undefined,
  );
}

/** One release being staged on the worker thread, as the loop's job in pieces. */
export class StagingJob {
  readonly #inputs: StageInputs;
  readonly #options: StagingJobOptions;
  readonly #control = stagingControl();
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
  /** This job holds the gate (it began), until it is over. */
  #holdsGate = false;

  constructor(inputs: StageInputs, options: StagingJobOptions = {}) {
    this.#inputs = inputs;
    this.#options = options;
    if (!gate.busy) {
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
      this.#endWith(failed("an earlier staging has not yet ended"));
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

  /** The outcome once the job has ended; undefined while the worker stages. */
  next(): FileOutcome | undefined {
    if (this.#taken !== undefined) return this.#taken;
    if (this.#removing > 0) return undefined;
    const outcome = this.#outcome;
    if (this.#wanted()) return outcome === undefined ? undefined : this.#take(outcome);
    if (outcome === undefined) {
      this.#cancel();
      return this.#outcome === undefined ? undefined : this.#take(this.#outcome);
    }
    // Unwanted when it ended: "cancelled", and a version already in place removed first.
    const prefix = this.#inputs.prefix;
    if (outcome.kind !== "updateStaged" || prefix === undefined)
      return this.#take(failed(CANCELLED));
    this.#outcome = failed(CANCELLED);
    this.#removing += 1;
    void removed([join(installPaths(prefix).staged, outcome.version)]).then(() => {
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
      Atomics.store(this.#control, 0, STAGING_STOP);
      Atomics.wait(this.#control, 1, 0, this.#options.stopWaitMs ?? STOP_WAIT_MS);
    }
    this.#taken ??= failed(message);
    this.#maybeRelease();
    return this.#taken;
  }

  #wanted(): boolean {
    return this.#inputs.wanted?.() !== false;
  }

  #begin(): void {
    this.#queued = undefined;
    clearTimeout(this.#timer);
    gate.busy = true;
    this.#holdsGate = true;
    this.#phase = "running";
    // Everything but `wanted`, a function, which the worker sees as the control word.
    const { path, prefix, runningVersion, platform, keys } = this.#inputs;
    const started = (this.#options.start ?? startStagingThread)(
      { inputs: { path, prefix, runningVersion, platform, keys }, control: this.#control },
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
      this.#endWith(failed(`the staging worker did not start: ${started.error}`));
    }
  }

  #cancel(): void {
    if (this.#phase === "queued") {
      this.#unqueue();
      this.#exited = true;
      this.#endWith(failed(CANCELLED));
      return;
    }
    if (this.#phase !== "running" || this.#cancelling) return;
    this.#cancelling = true;
    Atomics.store(this.#control, 0, STAGING_CANCEL);
    this.#timer = setTimeout(() => {
      // The worker is still in a file call: what it left removed off the loop. When the call
      // returns, it sees the cancel before its next piece and ends on its own.
      this.#removeLeftovers(failed(CANCELLED));
    }, this.#options.cancelWaitMs ?? CANCEL_WAIT_MS);
  }

  #threadExited(): void {
    this.#exited = true;
    const why = this.#why;
    if (why !== undefined && this.#outcome === undefined && this.#phase !== "over")
      this.#removeLeftovers(failed(`the staging worker ended without an outcome: ${why}`));
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

  /** The `.staging-*` folders a worker left, removed off the loop; then the job ends so. */
  #removeLeftovers(outcome: FileOutcome): void {
    const prefix = this.#inputs.prefix;
    if (prefix === undefined) {
      this.#endWith(outcome);
      return;
    }
    const staged = installPaths(prefix).staged;
    this.#removing += 1;
    void ResultAsync.fromPromise(readdir(staged), () => undefined)
      .match(
        (names) => names.filter((name) => name.startsWith(".staging-")).map((n) => join(staged, n)),
        () => [],
      )
      .then(removed)
      .then(() => {
        this.#removing -= 1;
        this.#endWith(outcome);
      });
  }

  #unqueue(): void {
    const queued = this.#queued;
    if (queued === undefined) return;
    this.#queued = undefined;
    const at = gate.queue.indexOf(queued);
    if (at !== -1) gate.queue.splice(at, 1);
  }

  /** The gate opened for the next staging, once this one is over: taken or aborted, its thread gone, nothing being removed. */
  #maybeRelease(): void {
    if (!this.#holdsGate || !this.#exited || this.#removing > 0 || this.#phase !== "over") return;
    this.#holdsGate = false;
    gate.busy = false;
    gate.queue.shift()?.();
  }
}
