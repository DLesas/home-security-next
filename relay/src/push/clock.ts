/**
 * Time for the push role's links: the wall clock and timers, injected so tests drive them.
 */
export interface LinkClock {
  now(): number;
  /** Runs `run` after `ms`; the function returned cancels it. */
  after(ms: number, run: () => void): () => void;
}

export const SYSTEM_CLOCK: LinkClock = {
  now: () => Date.now(),
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};
