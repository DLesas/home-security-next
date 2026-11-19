/**
 * Time for the scripted air and boards. Everything the bench does later (a notification on its
 * way, a Get asked again after 3 s, a window's end) is a timer on a `Clock`, so the same boards
 * run in real time behind the bridge and in a test's own time under `bun test`:
 *
 * - `realClock`: the process's monotonic clock and `setTimeout`.
 * - `ManualClock`: time moves only when the test says. `advance` runs the timers due in time
 *   order (ties in the order they were set) and lets promises settle after each, so code under
 *   test that awaits a write or a read sees its answer before the next timer runs. A two-minute
 *   window ends in a few milliseconds of the test's run.
 */

export interface Clock {
  /** Milliseconds, monotonic. */
  now(): number;
  /** Runs `run` after `ms` (0 or less: as soon as possible); returns the cancel. */
  after(ms: number, run: () => void): () => void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, Math.max(0, ms));
    return () => {
      clearTimeout(timer);
    };
  },
};

interface Timer {
  readonly at: number;
  readonly order: number;
  readonly run: () => void;
  live: boolean;
}

/** One turn of the event loop: every promise continuation queued so far runs first. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class ManualClock implements Clock {
  #now = 0;
  #order = 0;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  after(ms: number, run: () => void): () => void {
    const timer: Timer = { at: this.#now + Math.max(0, ms), order: this.#order++, run, live: true };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Timers still to run. */
  get pending(): number {
    return this.#timers.filter((t) => t.live).length;
  }

  #next(until: number): Timer | undefined {
    let best: Timer | undefined;
    for (const timer of this.#timers) {
      if (!timer.live || timer.at > until) continue;
      if (
        best === undefined ||
        timer.at < best.at ||
        (timer.at === best.at && timer.order < best.order)
      )
        best = timer;
    }
    return best;
  }

  /** Runs every timer due within the next `ms`, in order, and ends with the time `ms` later. */
  async advance(ms: number): Promise<void> {
    const end = this.#now + Math.max(0, ms);
    await settle();
    for (let timer = this.#next(end); timer !== undefined; timer = this.#next(end)) {
      timer.live = false;
      this.#now = Math.max(this.#now, timer.at);
      timer.run();
      await settle();
    }
    this.#timers = this.#timers.filter((t) => t.live);
    this.#now = end;
  }

  /**
   * Jumps from timer to timer until `done()` holds or `limitMs` have passed; true when it held.
   * The time ends at the moment it held, so a test can read what was true then.
   */
  async runUntil(done: () => boolean, limitMs: number): Promise<boolean> {
    const end = this.#now + limitMs;
    await settle();
    while (!done()) {
      const timer = this.#next(end);
      if (timer === undefined) {
        this.#now = end;
        return done();
      }
      timer.live = false;
      this.#now = Math.max(this.#now, timer.at);
      timer.run();
      await settle();
    }
    this.#timers = this.#timers.filter((t) => t.live);
    return true;
  }
}
